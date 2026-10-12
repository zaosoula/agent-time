import { mkdirSync, existsSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventStore } from './store.ts';
import { makeEvent, type Summary } from './events.ts';
import { readWorkers, readFleet, workerEvent, terminalEvents, callOrca } from './orca.ts';
import { importSpool } from './hooks.ts';
import { normalizeActivity } from './macos.ts';
import { summarize } from './correlate.ts';
export class Collector {
  readonly output:string; readonly store:EventStore;
  private running=false; private timer:ReturnType<typeof setTimeout>|undefined; private deadline:ReturnType<typeof setTimeout>|undefined;
  private helper:ChildProcess|undefined; private inFlight:Promise<void>|undefined; private lastPoll:number|null=null;
  private lastError:string|null=null; private macos:Record<string,unknown>|null=null; private lockOwned=false;
  private stopping:Promise<ReturnType<Collector['status']>>|undefined;
  private probe?:string; private interval:number; private runId?:string; private reader:typeof callOrca;
  constructor(output:string,probe?:string,interval=5,runId?:string,reader:typeof callOrca=callOrca) {
    this.probe=probe;this.interval=interval;this.runId=runId;this.reader=reader;
    this.output=output;mkdirSync(output,{recursive:true,mode:0o700});this.store=new EventStore(join(output,'events.sqlite'));
  }
  status(){return {running:this.running,lastPoll:this.lastPoll,lastError:this.lastError,eventCount:this.store.events().length,macos:this.macos,output:this.output};}
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
    if(this.probe&&existsSync(this.probe)) {
      this.helper=spawn(this.probe,[],{stdio:['ignore','pipe','pipe']});
      const lines=createInterface({input:this.helper.stdout!});
      lines.on('line',line=>{try{const payload=JSON.parse(line);this.macos=payload;this.store.put(normalizeActivity(payload,{hostId:'local'}));}catch{this.lastError='Invalid macOS observation';}});
      this.helper.on('error',()=>{this.lastError='macOS activity helper unavailable';});
      this.helper.on('exit',()=>{if(this.running){this.lastError='macOS helper exited';this.store.put(makeEvent('macos','coverage',{data:{reason:'macOS activity helper exited'}}));}});
    } else this.store.put(makeEvent('macos','coverage',{data:{reason:'macOS activity helper not available; human activity is unverified'}}));
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
      const {workers,coverage}=this.runId?await readWorkers(this.reader,this.runId,()=>this.running):await readFleet(this.reader,()=>this.running);
      for(const w of workers)this.store.put(workerEvent(w));
      for(const issue of coverage)this.store.put(makeEvent('orca','coverage',{data:{reason:issue.reason}}));
      if(this.running)try{for(const e of await terminalEvents(this.reader))this.store.put(e);}catch(error){this.store.put(makeEvent('orca','coverage',{data:{reason:String(error)}}));}
      for(const issue of importSpool(join(this.output,'spool'),this.store))this.store.put(makeEvent('hook','coverage',{data:{reason:issue.reason}}));
      this.lastPoll=Date.now()/1000;this.lastError=coverage.find(i=>!i.reason.startsWith('Only this Orca host'))?.reason||null;
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
    await this.inFlight;
    importSpool(join(this.output,'spool'),this.store);
    this.store.put(makeEvent('capture','capture_stop'));
    if(this.lockOwned){const lock=join(this.output,'capture.lock');if(existsSync(lock)&&readFileSync(lock,'utf8')===String(process.pid))unlinkSync(lock);this.lockOwned=false;}
    return this.status();
  }
  async close(){await this.stop();this.store.close();}
}
