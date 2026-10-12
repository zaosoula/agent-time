import { mkdirSync, existsSync, writeFileSync, readFileSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventStore } from './store.ts';
import { makeEvent, type Summary, type CaptureEvent } from './events.ts';
import { defaultSettings, validateSettings, type CaptureSettings } from './settings.ts';
import { readWorkers, readFleet, workerEvent, terminalEvents, callOrca } from './orca.ts';
import { importSpool } from './hooks.ts';
import { normalizeActivity } from './macos.ts';
import { summarize } from './correlate.ts';
import { dailyTotals } from './daily.ts';
import {UsageReader} from '../usage/reader.ts';
import {HookInstallation,type HookProvider} from './hook-installation.ts';
export class Collector {
  readonly output:string; readonly store:EventStore;
  private running=false; private timer:ReturnType<typeof setTimeout>|undefined; private deadline:ReturnType<typeof setTimeout>|undefined;
  private helper:ChildProcess|undefined; private inFlight:Promise<void>|undefined; private lastPoll:number|null=null;
  private lastError:string|null=null; private macos:Record<string,unknown>|null=null; private lockOwned=false;
  private stopping:Promise<ReturnType<Collector['status']>>|undefined;
  private surfaces:CaptureSettings={...defaultSettings}; private revision=0;
  private surfaceHistory:CaptureEvent[]=[];
  private usageReader:UsageReader;private hookInstallation:HookInstallation;
  private probe?:string; private interval:number; private runId?:string; private reader:typeof callOrca;
  constructor(output:string,probe?:string,interval=5,runId?:string,reader:typeof callOrca=callOrca) {
    this.probe=probe;this.interval=interval;this.runId=runId;this.reader=reader;
    this.output=output;mkdirSync(output,{recursive:true,mode:0o700});this.store=new EventStore(join(output,'events.sqlite'));
    const settings=join(output,'settings.json');
    if(existsSync(settings)) {
      const config=JSON.parse(readFileSync(settings,'utf8'));
      const known=Object.fromEntries(Object.keys(defaultSettings).filter(k=>k in config).map(k=>[k,config[k]]));
      this.surfaces={...defaultSettings,...validateSettings(known)};
    }
    this.surfaceHistory=this.store.events().filter(e=>e.kind==='capture_settings').sort((a,b)=>a.observedAt-b.observedAt);
    this.usageReader=new UsageReader(join(output,'events.sqlite'),undefined,this.reader);this.hookInstallation=new HookInstallation(output);this.syncUsage();
  }
  private syncUsage(){const s=this.surfaces;this.usageReader.configureProviders({claude:s.claudeTokenUsage,codex:s.codexTokenUsage});if(this.running&&s.tokenUsage&&(s.claudeTokenUsage||s.codexTokenUsage))this.usageReader.start();else void this.usageReader.stop();}
  status(){return {running:this.running,orcaPolling:this.surfaces.orcaPolling,surfaces:{...this.surfaces},lastPoll:this.lastPoll,lastError:this.lastError,eventCount:this.store.events().length,macos:this.macos,output:this.output};}
  trayStatus(){const now=new Date(),date=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;const usage=this.usageReader.summary().days.filter(d=>d.date===date);return {running:this.running,...dailyTotals(summarize(this.store.events())),tokensToday:usage.reduce((n,d)=>n+d.tokens,0),apiUsdToday:usage.reduce((n,d)=>n+d.usd,0),unpricedToday:usage.reduce((n,d)=>n+d.unpriced,0)};}
  hooksStatus(){return this.hookInstallation.status();}
  verifyHooks(){return this.hookInstallation.verify();}
  installHooks(provider:HookProvider){return this.hookInstallation.install(provider);}
  dismissHookSetup(){return this.hookInstallation.dismiss();}
  usage(){return this.usageReader.summary();}
  updateSettings(patch:Partial<CaptureSettings>){
    validateSettings(patch);
    if(this.stopping)throw new Error('Capture is stopping');
    if(!this.lockOwned&&existsSync(join(this.output,'capture.lock')))throw new Error('Change settings in the app that owns capture');
    const next={...this.surfaces,...patch};
    if(Object.keys(defaultSettings).every(k=>next[k as keyof CaptureSettings]===this.surfaces[k as keyof CaptureSettings]))return this.status();
    if(this.lockOwned)this.drainHooks();
    const path=join(this.output,'settings.json'),existing=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{};
    writeFileSync(path+'.tmp',JSON.stringify({...existing,...next},null,2)+'\n',{mode:0o600});renameSync(path+'.tmp',path);
    const change=makeEvent('capture','capture_settings',{data:{previous:{...this.surfaces},surfaces:next}});
    this.store.put(change);this.surfaceHistory.push(change);this.surfaces=next;this.revision++;
    if(!next.macosActivity){const helper=this.helper;this.helper=undefined;helper?.kill('SIGTERM');this.macos=null;}
    else if(this.running&&!this.helper)this.startHelper();
    this.syncUsage();
    if(this.running&&!this.inFlight){clearTimeout(this.timer);void this.tick();}
    return this.status();
  }
  private acceptHook(event:CaptureEvent){
    const key=event.provider==='claude'?'claudeHooks':event.provider==='codex'?'codexHooks':undefined;
    if(!key||!this.surfaces[key])return false;
    let enabled=(this.surfaceHistory[0]?.data?.previous as CaptureSettings|undefined)?.[key]??this.surfaces[key];
    for(const change of this.surfaceHistory){if(change.observedAt>event.observedAt)break;enabled=(change.data?.surfaces as CaptureSettings)?.[key]??enabled;}
    return enabled===true;
  }
  private drainHooks(){return importSpool(join(this.output,'spool'),this.store,event=>this.acceptHook(event));}
  private startHelper(){
    if(!this.surfaces.macosActivity)return;
    if(this.probe&&existsSync(this.probe)) {
      const helper=spawn(this.probe,[],{stdio:['ignore','pipe','pipe']});this.helper=helper;
      const lines=createInterface({input:helper.stdout!});
      lines.on('line',line=>{if(!this.running||this.helper!==helper||!this.surfaces.macosActivity)return;try{const payload=JSON.parse(line);this.macos=payload;this.store.put(normalizeActivity(payload,{hostId:'local'}));}catch{this.lastError='Invalid macOS observation';}});
      helper.on('error',()=>{if(this.helper===helper)this.lastError='macOS activity helper unavailable';});
      helper.on('exit',()=>{if(this.running&&this.helper===helper){this.helper=undefined;this.lastError='macOS helper exited';this.store.put(makeEvent('macos','coverage',{data:{reason:'macOS activity helper exited'}}));}});
    } else this.store.put(makeEvent('macos','coverage',{data:{reason:'macOS activity helper not available; human activity is unverified'}}));
  }
  summary():Summary {
    const events=this.store.events(),summary=summarize(events);
    const terminals=new Map(events.filter(e=>e.kind==='terminal').map(e=>[e.terminalHandle,e]));
    for(const s of summary.sessions){const t=terminals.get(s.terminalHandle);if(t&&!s.child){s.title=String(t.data?.title||s.title).replace(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✳◐◓◑◒]\s*/, '');s.cwd=t.cwd||s.cwd;}}
    return summary;
  }
  async start(durationSeconds=3600) {
    if(!Number.isFinite(durationSeconds)||durationSeconds<1||durationSeconds>86400)throw new Error('Duration must be 1–86400 seconds');
    if(this.running)return this.status();
    if(this.stopping)throw new Error('Capture is stopping');
    const lock=join(this.output,'capture.lock');
    if(existsSync(lock)) {
      const pid=Number(readFileSync(lock,'utf8'));
      if(!Number.isInteger(pid)||pid<1)throw new Error('Unreadable collector lock; inspect before removing');
      try{process.kill(pid,0);throw new Error('Another collector owns this data directory');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
      unlinkSync(lock);
    }
    writeFileSync(lock,String(process.pid),{mode:0o600,flag:'wx'});this.lockOwned=true;this.running=true;this.lastError=null;
    this.store.put(makeEvent('capture','capture_start'));
    this.startHelper();
    this.syncUsage();
    this.deadline=setTimeout(()=>{void this.stop();},durationSeconds*1000);
    await this.tick();return this.status();
  }
  private async tick() {
    if(!this.running)return;
    this.inFlight=this.poll();await this.inFlight;this.inFlight=undefined;
    if(this.running)this.timer=setTimeout(()=>{void this.tick();},this.interval*1000);
  }
  private async poll() {
    try{
      let pollingError:string|null=null;
      if(this.surfaces.orcaPolling){
        const revision=this.revision,valid=()=>this.running&&this.surfaces.orcaPolling&&this.revision===revision;
        const {workers,coverage}=this.runId?await readWorkers(this.reader,this.runId,valid):await readFleet(this.reader,valid);
        if(valid()){
          for(const w of workers)this.store.put(workerEvent(w));
          for(const issue of coverage)this.store.put(makeEvent('orca','coverage',{data:{reason:issue.reason}}));
          try{const terminals=await terminalEvents(this.reader);if(valid())for(const e of terminals)this.store.put(e);}catch(error){if(valid())this.store.put(makeEvent('orca','coverage',{data:{reason:String(error)}}));}
          pollingError=coverage.find(i=>!i.reason.startsWith('Only this Orca host'))?.reason||null;
        }
      }
      for(const issue of this.drainHooks())this.store.put(makeEvent('hook','coverage',{data:{reason:issue.reason}}));
      this.lastPoll=Date.now()/1000;this.lastError=pollingError;
    }catch(error){this.lastError=String(error);this.store.put(makeEvent('capture','coverage',{data:{reason:this.lastError}}));}
  }
  stop():Promise<ReturnType<Collector['status']>> {
    if(this.stopping)return this.stopping;
    if(!this.lockOwned)return Promise.resolve(this.status());
    this.stopping=this.stopOwned().finally(()=>{this.stopping=undefined;});return this.stopping;
  }
  private async stopOwned() {
    this.running=false;clearTimeout(this.timer);clearTimeout(this.deadline);
    // Kill the helper immediately; slow fleet reads cannot orphan it during shutdown.
    if(this.helper){this.helper.kill('SIGTERM');this.helper=undefined;}
    await this.usageReader.stop();
    await this.inFlight;
    this.drainHooks();
    this.store.put(makeEvent('capture','capture_stop'));
    if(this.lockOwned){const lock=join(this.output,'capture.lock');if(existsSync(lock)&&readFileSync(lock,'utf8')===String(process.pid))unlinkSync(lock);this.lockOwned=false;}
    return this.status();
  }
  async close(){await this.stop();await this.usageReader.close();this.store.close();}
}
