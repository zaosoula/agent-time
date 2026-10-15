import { mkdirSync, existsSync, writeFileSync, readFileSync, unlinkSync, renameSync, lstatSync, statSync } from 'node:fs';
import { join, isAbsolute, basename, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventStore } from './store.ts';
import { makeEvent, type Summary, type CaptureEvent } from './events.ts';
import { defaultSettings, validateSettings, storedSettings, browserEnabled, type CaptureSettings } from './settings.ts';
import { readWorkers, readFleet, workerEvent, terminalEvents, callOrca } from './orca.ts';
import { importSpool } from './hooks.ts';
import { normalizeActivity,probeCapabilities } from './macos.ts';
import {resolveOrcaTab,tabIndexFromTerminalList,type FocusedOrcaTab} from './orca-focus.ts';
import { summarize } from './correlate.ts';
import { dailyTotals,summaryForDate } from './daily.ts';
import {UsageReader} from '../usage/reader.ts';
import {HookInstallation,type HookProvider} from './hook-installation.ts';
import {compactHealthEvents,websiteHealth,type CaptureHealth,type AccessibilityCapture} from './health.ts';
import {WebsiteResolver,websiteKey,projectPathFromWorktree,type KnownWorkspace,type WebsiteResolution} from './website-resolver.ts';
import {LinearConnection,keychainHelper} from './linear.ts';
import {applyHumanDecisions,humanIntervalKey} from './human-review.ts';
export class Collector {
  readonly output:string; readonly store:EventStore;
  private running=false; private timer:ReturnType<typeof setTimeout>|undefined; private deadline:ReturnType<typeof setTimeout>|undefined;
  private helper:ChildProcess|undefined; private inFlight:Promise<void>|undefined; private lastPoll:number|null=null;
  private lastError:string|null=null; private macos:Record<string,unknown>|null=null; private lockOwned=false;
  private stopping:Promise<ReturnType<Collector['status']>>|undefined;
  private surfaces:CaptureSettings={...defaultSettings}; private revision=0;
  private surfaceHistory:CaptureEvent[]=[];
  private summaryCache:{revision:string;at:number;value:Summary}|undefined;private usageReader:UsageReader;private hookInstallation:HookInstallation;
  private probe?:string; private interval:number; private runId?:string; private reader:typeof callOrca;
  private focusedTabs:FocusedOrcaTab[]=[];private focusedTabsAt=0;
  private lastOrcaAccessibility:AccessibilityCapture|null=null;
  private probeCheckAt=0;private probeRefresh:Promise<void>|undefined;
  private legacyHookSpools:string[]=[];
  private focusRefresh:Promise<void>|undefined;
  private websiteResolver:WebsiteResolver;private websiteMatches=new Map<string,WebsiteResolution>();private websiteApplied=new Map<string,number>();private websitePending=new Map<string,Promise<void>>();private websiteRevision=0;
  private linear:LinearConnection;
  constructor(output:string,probe?:string,interval=5,runId?:string,reader:typeof callOrca=callOrca,keychainPath=resolve('.capture/bin/linear-keychain')) {
    this.probe=probe;this.interval=interval;this.runId=runId;this.reader=reader;
    this.output=output;mkdirSync(output,{recursive:true,mode:0o700});this.store=new EventStore(join(output,'events.sqlite'));
    this.websiteResolver=new WebsiteResolver(output);
    this.linear=new LinearConnection(output,keychainHelper(keychainPath));
    const settings=join(output,'settings.json');
    if(existsSync(settings)) {
      const config=JSON.parse(readFileSync(settings,'utf8'));
      this.surfaces=storedSettings(config);
      if(Array.isArray(config.legacyHookSpools)){
        const candidates:unknown[]=config.legacyHookSpools;
        this.legacyHookSpools=[...new Set(candidates.filter((p):p is string=>typeof p==='string'&&isAbsolute(p)&&basename(p)==='spool').map(p=>resolve(p)).filter(p=>p!==resolve(output,'spool')))];
      }
    }
    this.surfaceHistory=this.store.events().filter(e=>e.kind==='capture_settings').sort((a,b)=>a.observedAt-b.observedAt);
    this.usageReader=new UsageReader(join(output,'events.sqlite'),undefined,this.reader);this.hookInstallation=new HookInstallation(output);this.syncUsage();
  }
  private syncUsage(){const s=this.surfaces;this.usageReader.configureProviders({claude:s.claudeTokenUsage,codex:s.codexTokenUsage});if(this.running&&s.tokenUsage&&(s.claudeTokenUsage||s.codexTokenUsage))this.usageReader.start();else void this.usageReader.stop();}
  status(){return {running:this.running,orcaPolling:this.surfaces.orcaPolling,surfaces:{...this.surfaces},lastPoll:this.lastPoll,lastError:this.lastError,eventCount:this.store.count(),macos:this.macos,output:this.output};}
  trayStatus(){const now=new Date(),date=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;const usage=this.usageReader.summary().days.filter(d=>d.date===date);return {running:this.running,...dailyTotals(this.summary(15000)),tokensToday:usage.reduce((n,d)=>n+d.tokens,0),apiUsdToday:usage.reduce((n,d)=>n+d.usd,0),unpricedToday:usage.reduce((n,d)=>n+d.unpriced,0)};}
  cleanupPreview(){return this.hookInstallation.cleanupPreview();}
  cleanupTracking(){return this.hookInstallation.cleanup();}
  hooksStatus(){return this.hookInstallation.status();}
  captureHealth():CaptureHealth{
    const macos=this.store.recent('macos',16),claude=this.store.recent('hook',24,'claude'),codex=this.store.recent('hook',24,'codex'),orca=this.store.recent('orca',32),capture=this.store.recent('capture',8);
    const targets=this.hookInstallation.status().targets;
    const hooks=(provider:HookProvider)=>{const own=targets.filter(t=>t.provider===provider);return {installed:own.filter(t=>t.state==='installed').length,total:own.length,needsAttention:own.some(t=>t.state==='needs-update'||t.state==='error')};};
    const currentUrl=typeof this.macos?.browserUrl==='string'?this.macos.browserUrl:null,currentKey=currentUrl?websiteKey(currentUrl,this.websiteResolver.rules()):null;
    const current=currentKey?{key:currentKey,observedAt:Number(this.macos?.observedAt)||0}:undefined;
    return {checkedAt:Date.now()/1000,latest:{macos:macos[0]?.observedAt||null,claude:claude[0]?.observedAt||null,codex:codex[0]?.observedAt||null,orca:orca[0]?.observedAt||null},hooks:{claude:hooks('claude'),codex:hooks('codex')},accessibility:this.lastOrcaAccessibility,websites:websiteHealth([...this.websiteMatches.values()],this.websiteApplied,current),events:compactHealthEvents([...macos,...claude,...codex,...orca,...capture])};
  }
  verifyHooks(){return this.hookInstallation.verify();}
  installHooks(provider:HookProvider){return this.hookInstallation.install(provider);}
  dismissHookSetup(){return this.hookInstallation.dismiss();}
  usage(){return this.usageReader.summary();}
  async linearStatus(){
    const status=await this.linear.status();
    if(!status.workspaces.length||!status.projects.length)return {...status,repositoryMatches:{}};
    const slugs=[...new Set(status.projects.flatMap(project=>project.repositories))];
    return {...status,repositoryMatches:await this.websiteResolver.repositoryProjects(slugs,this.knownWorkspaces())};
  }
  linearConnect(clientId:string){return this.linear.connect(clientId);}
  linearSync(workspaceId?:string){return this.linear.sync(workspaceId);}
  linearDisconnect(workspaceId?:string){return this.linear.disconnect(workspaceId);}
  private knownWorkspaces():KnownWorkspace[]{
    const known=new Map<string,KnownWorkspace>();
    for(const session of this.summary(15000).sessions){
      const workspaceId=session.workspaceId,path=session.cwd||workspaceId?.split('::').at(-1);
      if(workspaceId&&path&&isAbsolute(path))known.set(workspaceId,{workspaceId,workspacePath:resolve(path),projectPath:projectPathFromWorktree(path)});
    }
    for(const tab of this.focusedTabs){const path=tab.workspaceId.split('::').at(-1);if(path&&isAbsolute(path))known.set(tab.workspaceId,{workspaceId:tab.workspaceId,workspacePath:resolve(path),projectPath:projectPathFromWorktree(path)});}
    return [...known.values()];
  }
  websiteProjects(){
    const paths=[...new Set([...this.websiteResolver.candidateProjects(this.knownWorkspaces()),...[...this.websiteMatches.values()].map(match=>match.projectPath).filter((path):path is string=>Boolean(path))])].sort();
    return {rules:this.websiteResolver.rules(),projects:paths,matches:[...this.websiteMatches.values()].sort((a,b)=>b.observedAt-a.observedAt).slice(0,30)};
  }
  setWebsiteRule(pattern:string,projectPath:string){
    if(!this.lockOwned&&existsSync(join(this.output,'capture.lock')))throw new Error('Change website rules in the app that owns capture');
    this.websiteResolver.setRule(pattern,projectPath);this.websiteRevision++;this.websiteMatches.clear();this.websiteApplied.clear();return this.websiteProjects();
  }
  removeWebsiteRule(pattern:string){
    if(!this.lockOwned&&existsSync(join(this.output,'capture.lock')))throw new Error('Change website rules in the app that owns capture');
    this.websiteResolver.removeRule(pattern);this.websiteRevision++;this.websiteMatches.clear();this.websiteApplied.clear();return this.websiteProjects();
  }
  setHumanDecision(pairs:Array<[string,string]>,mode:'assigned'|'unassigned'|'clear',projectPath?:string):Summary {
    if(!this.lockOwned&&existsSync(join(this.output,'capture.lock')))throw new Error('Review activity in the app that owns capture');
    if(!Array.isArray(pairs)||!pairs.length||pairs.length>500||!['assigned','unassigned','clear'].includes(mode))throw new Error('Invalid activity selection');
    const keys=new Set(this.summary().intervals.filter(i=>i.state==='human').map(humanIntervalKey).filter(Boolean));
    if(pairs.some(pair=>!Array.isArray(pair)||pair.length!==2||pair.some(id=>typeof id!=='string'||!id||id.length>128)||!keys.has(`${pair[0]}:${pair[1]}`)))throw new Error('Activity changed; refresh and try again');
    let path:string|null=null;
    if(mode==='assigned'){
      if(typeof projectPath!=='string'||!isAbsolute(projectPath))throw new Error('Choose an absolute project directory');
      path=projectPathFromWorktree(projectPath);
      if(!existsSync(path)||!statSync(path).isDirectory())throw new Error('Choose an existing project directory');
    }
    this.store.setHumanDecisions([...new Map(pairs.map(pair=>[pair.join(':'),pair])).values()],mode,path);
    this.summaryCache=undefined;
    return this.summary();
  }
  private resolveWebsite(url:string){
    const key=websiteKey(url,this.websiteResolver.rules());if(!key||this.websitePending.has(key))return;
    const revision=this.websiteRevision,known=this.knownWorkspaces(),recent=this.lastOrcaAccessibility?.selectedWorktreeId?{workspaceId:this.lastOrcaAccessibility.selectedWorktreeId,observedAt:this.lastOrcaAccessibility.observedAt}:undefined;
    const pending=this.websiteResolver.resolve(url,known,recent).then(result=>{if(result&&this.running&&revision===this.websiteRevision){if(this.websiteMatches.get(key)?.projectPath!==result.projectPath)this.websiteApplied.delete(key);this.websiteMatches.set(key,result);if(this.websiteMatches.size>200){const oldest=[...this.websiteMatches].sort((a,b)=>a[1].observedAt-b[1].observedAt).slice(0,this.websiteMatches.size-200);for(const [oldKey] of oldest){this.websiteMatches.delete(oldKey);this.websiteApplied.delete(oldKey);}}}}).catch(()=>{/* Keep unverified website activity unassigned. */}).finally(()=>{if(this.websitePending.get(key)===pending)this.websitePending.delete(key);});
    this.websitePending.set(key,pending);
  }
  updateSettings(patch:Partial<CaptureSettings>){
    validateSettings(patch);
    if(this.stopping)throw new Error('Capture is stopping');
    if(!this.lockOwned&&existsSync(join(this.output,'capture.lock')))throw new Error('Change settings in the app that owns capture');
    const next={...this.surfaces,...patch};
    if(Object.keys(defaultSettings).every(k=>next[k as keyof CaptureSettings]===this.surfaces[k as keyof CaptureSettings]))return this.status();
    const browserChanged=Object.values(['browserSafari','browserChrome','browserBrave'] as const).some(key=>next[key]!==this.surfaces[key]);
    if(this.lockOwned)this.drainHooks();
    const path=join(this.output,'settings.json'),existing=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{};
    writeFileSync(path+'.tmp',JSON.stringify({...existing,...next},null,2)+'\n',{mode:0o600});renameSync(path+'.tmp',path);
    const change=makeEvent('capture','capture_settings',{data:{previous:{...this.surfaces},surfaces:next}});
    this.store.put(change);this.surfaceHistory.push(change);this.surfaces=next;this.revision++;this.summaryCache=undefined;
    if(!next.macosActivity||browserChanged){const helper=this.helper;this.helper=undefined;helper?.kill('SIGTERM');this.macos=null;if(!next.macosActivity){this.focusedTabs=[];this.focusedTabsAt=0;}}
    if(this.running&&next.macosActivity&&!this.helper)this.startHelper();
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
  private drainHooks(){
    const accept=(event:CaptureEvent)=>this.acceptHook(event);
    const issues=importSpool(join(this.output,'spool'),this.store,accept);
    for(const path of this.legacyHookSpools){
      try{const info=lstatSync(path);if(info.isDirectory()&&!info.isSymbolicLink())issues.push(...importSpool(path,this.store,accept));}catch{/* Retired legacy directories can be removed after existing sessions exit. */}
    }
    return issues;
  }
  private startHelper(){
    if(!this.surfaces.macosActivity)return;
    if(this.probe&&existsSync(this.probe)) {
      const args=[this.surfaces.browserSafari&&'--browser-safari',this.surfaces.browserChrome&&'--browser-chrome',this.surfaces.browserBrave&&'--browser-brave'].filter((arg):arg is string=>Boolean(arg));
      const helper=spawn(this.probe,args,{stdio:['ignore','pipe','pipe']});this.helper=helper;
      const lines=createInterface({input:helper.stdout!});
      lines.on('line',line=>{if(!this.running||this.helper!==helper||!this.surfaces.macosActivity)return;try{
        const payload=JSON.parse(line);
        if(!browserEnabled(this.surfaces,payload.foregroundBundleId)){delete payload.browserDomain;delete payload.browserUrl;delete payload.browserTitle;}
        const event=normalizeActivity(payload,{hostId:'local'});
        const browserUrl=event.data?.browserUrl;
        if(typeof browserUrl==='string'){
          const key=websiteKey(browserUrl,this.websiteResolver.rules()),match=key?this.websiteMatches.get(key):undefined;
          if(match&&Date.now()/1000-match.observedAt<5&&match.projectPath){event.workspaceId=match.workspaceId;event.data={...event.data,websiteAttribution:{source:match.source,projectPath:match.projectPath,detail:match.detail}};if(key){this.websiteApplied.set(key,event.observedAt);if(this.websiteApplied.size>200)this.websiteApplied.delete(this.websiteApplied.keys().next().value!);}}
          if(!match||Date.now()/1000-match.observedAt>=3)this.resolveWebsite(browserUrl);
        }
        const focused=payload.foregroundBundleId==='com.stablyai.orca'&&Date.now()-this.focusedTabsAt<15000?resolveOrcaTab(payload.orcaSelectedTabTitle,this.focusedTabs):null;
        const worktree=payload.foregroundBundleId==='com.stablyai.orca'&&typeof payload.orcaSelectedWorktreeId==='string'?payload.orcaSelectedWorktreeId:undefined;
        const matchingTab=focused&&(!worktree||focused.workspaceId===worktree)?focused:null;
        if(worktree)event.workspaceId=worktree;
        if(matchingTab){event.workspaceId=matchingTab.workspaceId;event.terminalHandle=matchingTab.terminalHandle;event.data={...event.data,tabId:matchingTab.tabId,tabTitle:matchingTab.title,leafId:matchingTab.leafId};}
        const resolved=matchingTab?{workspaceId:matchingTab.workspaceId,tabId:matchingTab.tabId,leafId:matchingTab.leafId,terminalHandle:matchingTab.terminalHandle}:null;
        this.macos={...payload,orcaAttribution:matchingTab?{...resolved,title:matchingTab.title}:null,websiteAttribution:event.data?.websiteAttribution||null};
        if(payload.foregroundBundleId==='com.stablyai.orca')this.lastOrcaAccessibility={observedAt:event.observedAt,windowTitle:typeof payload.orcaWindowTitle==='string'?payload.orcaWindowTitle:null,selectedTabTitle:typeof payload.orcaSelectedTabTitle==='string'?payload.orcaSelectedTabTitle:null,selectedWorktreeId:worktree||null,resolved};
        this.store.put(event);
      }catch{this.lastError='Invalid macOS observation';}});
      helper.on('error',()=>{if(this.helper===helper)this.lastError='macOS activity helper unavailable';});
      helper.on('exit',()=>{if(this.running&&this.helper===helper){this.helper=undefined;this.lastError='macOS helper exited';this.store.put(makeEvent('macos','coverage',{data:{reason:'macOS activity helper exited'}}));}});
    } else this.store.put(makeEvent('macos','coverage',{data:{reason:'macOS activity helper not available; human activity is unverified'}}));
  }
  private refreshProbeTrust():Promise<void>|undefined{
    if(!this.running||!this.surfaces.macosActivity||!this.probe||!existsSync(this.probe)||this.probeRefresh||Date.now()-this.probeCheckAt<15000||!this.macos&&this.helper)return this.probeRefresh;
    this.probeCheckAt=Date.now();
    this.probeRefresh=probeCapabilities(this.probe).then(probe=>{
      if(!this.running||!this.surfaces.macosActivity)return;
      const trusted=probe.accessibilityTrusted===true;
      if(this.helper&&this.macos&&trusted===Boolean(this.macos.accessibilityTrusted))return;
      const previous=this.helper;this.helper=undefined;previous?.kill('SIGTERM');this.startHelper();
    }).catch(()=>{if(!this.helper)this.lastError='macOS activity helper unavailable';}).finally(()=>{this.probeRefresh=undefined;});
    return this.probeRefresh;
  }
  summary(maxAgeMs=0):Summary {
    const revision=this.store.revision();if(this.summaryCache&&(this.summaryCache.revision===revision||maxAgeMs>0&&Date.now()-this.summaryCache.at<maxAgeMs))return this.summaryCache.value;
    const events=this.store.events(),summary=applyHumanDecisions(summarize(events,{idleThreshold:this.surfaces.humanIdleMinutes*60,agentIdleThreshold:this.surfaces.agentIdleMinutes*60}),this.store.humanDecisions());
    const terminals=new Map(events.filter(e=>e.kind==='terminal').map(e=>[e.terminalHandle,e]));
    for(const s of summary.sessions){const t=terminals.get(s.terminalHandle);if(t&&!s.child){s.title=String(t.data?.title||s.title).replace(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✳◐◓◑◒]\s*/, '');s.cwd=t.cwd||s.cwd;}}
    this.summaryCache={revision,at:Date.now(),value:summary};return summary;
  }
  summaryForDate(date:string,maxAgeMs=0):Summary{return summaryForDate(this.summary(maxAgeMs),date);}
  async start(durationSeconds?:number) {
    if(durationSeconds!==undefined&&(!Number.isFinite(durationSeconds)||durationSeconds<1||durationSeconds>86400))throw new Error('Duration must be 1–86400 seconds');
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
    if(durationSeconds!==undefined)this.deadline=setTimeout(()=>{void this.stop();},durationSeconds*1000);
    await this.tick();return this.status();
  }
  private async tick() {
    if(!this.running)return;
    this.inFlight=this.poll();await this.inFlight;this.inFlight=undefined;
    if(this.running)this.timer=setTimeout(()=>{void this.tick();},this.interval*1000);
  }
  private refreshFocusedTabs(){
    if(this.focusRefresh||!this.running||!this.surfaces.macosActivity)return;
    this.focusRefresh=(async()=>{
      try{const receipt=await this.reader(['terminal','list','--include-visual-layouts','--limit','1000','--json']);if(this.running&&this.surfaces.macosActivity){this.focusedTabs=tabIndexFromTerminalList(receipt);this.focusedTabsAt=Date.now();}}
      catch{this.focusedTabs=[];this.focusedTabsAt=0;}
    })().finally(()=>{this.focusRefresh=undefined;});
  }
  private async poll() {
    try{
      let pollingError:string|null=null;
      void this.refreshProbeTrust();
      this.refreshFocusedTabs();
      if(this.surfaces.orcaPolling){
        const revision=this.revision,valid=()=>this.running&&this.surfaces.orcaPolling&&this.revision===revision;
        const {workers,coverage}=this.runId?await readWorkers(this.reader,this.runId,valid):await readFleet(this.reader,valid);
        if(valid()){
          this.store.putObservations(workers.map(workerEvent));
          for(const issue of coverage)this.store.put(makeEvent('orca','coverage',{data:{reason:issue.reason}}));
          try{const terminals=await terminalEvents(this.reader);if(valid())this.store.putObservations(terminals);}catch(error){if(valid())this.store.put(makeEvent('orca','coverage',{data:{reason:String(error)}}));}
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
    this.focusedTabs=[];this.focusedTabsAt=0;
    // Kill the helper immediately; slow fleet reads cannot orphan it during shutdown.
    if(this.helper){this.helper.kill('SIGTERM');this.helper=undefined;}
    await this.usageReader.stop();
    await this.inFlight;
    this.drainHooks();
    this.store.put(makeEvent('capture','capture_stop'));
    if(this.lockOwned){const lock=join(this.output,'capture.lock');if(existsSync(lock)&&readFileSync(lock,'utf8')===String(process.pid))unlinkSync(lock);this.lockOwned=false;}
    return this.status();
  }
  async close(){this.linear.close();await this.stop();await this.usageReader.close();this.store.close();}
}
