import { mkdirSync, existsSync, writeFileSync, readFileSync, unlinkSync, renameSync, lstatSync, statSync, statfsSync } from 'node:fs';
import { join, isAbsolute, basename, resolve } from 'node:path';
import {createHash} from 'node:crypto';
import { EventStore, type ManualNote } from './store.ts';
import { makeEvent, type Summary, type CaptureEvent } from './events.ts';
import { defaultSettings, validateSettings, storedSettings, browserEnabled, type CaptureSettings } from './settings.ts';
import { callOrca,orcaCliAvailable } from './orca.ts';
import { importSpool,spoolStatus } from './hooks.ts';
import { normalizeActivity,MacActivityProbe } from './macos.ts';
import {tabIndexFromTerminalList,type FocusedOrcaTab} from './orca-focus.ts';
import { summarize } from './correlate.ts';
import { dailyCaptureIssues,dailyTotals,summaryForDate,workingAgentCount } from './daily.ts';
import {appendActivitySummary} from './incremental-summary.ts';
import {UsageReader} from '../usage/reader.ts';
import {HookInstallation,type HookProvider} from './hook-installation.ts';
import {compactHealthEvents,websiteHealth,type CaptureHealth,type AccessibilityCapture} from './health.ts';
import {WebsiteResolver,websiteKey,projectPathFromWorktree,previewWebsiteRuleImpact,type KnownWorkspace,type WebsiteResolution} from './website-resolver.ts';
import {LinearConnection,keychainHelper} from './linear.ts';
import {applyHumanDecisions,groupHumanReview,humanIntervalKey,humanReviewState} from './human-review.ts';
import {unobservedGaps} from './gaps.ts';
import {agents,browsers,pollers,agentById,sourceMetadata,browserByBundle} from './sources/registry.ts';
import {outdatedHookTargets} from './hook-warning.ts';
import {diagnosticSummary} from './diagnostics.ts';
import {sourceStates} from './source-state.ts';
import {PrivacyExclusions,type PrivacyExclusion} from './privacy-exclusions.ts';
import {weeklyReview} from './weekly.ts';
import {localWorkOutcomes} from './work-outcomes.ts';
import {storageUsage} from './storage-usage.ts';
import {captureChecks} from './capture-checks.ts';
import {recoveryNotices} from './recovery.ts';
import {prepareCompaction,prepareRestore,cancelPendingReplacement,pendingReplacement,replacementResult} from './storage-migration.ts';
import {release as osRelease} from 'node:os';
import {randomUUID} from 'node:crypto';
export class Collector {
  readonly output:string; readonly store:EventStore;
  private running=false; private timer:ReturnType<typeof setTimeout>|undefined; private deadline:ReturnType<typeof setTimeout>|undefined;
  private activityProbe:MacActivityProbe; private inFlight:Promise<void>|undefined; private lastPoll:number|null=null;
  private lastError:string|null=null; private macos:Record<string,unknown>|null=null; private lockOwned=false;
  private failedPoller:string|null=null; private macError:string|null=null;
  private stopping:Promise<ReturnType<Collector['status']>>|undefined;
  private surfaces:CaptureSettings={...defaultSettings}; private revision=0;
  private surfaceHistory:CaptureEvent[]=[];
  private summaryCache:{revision:string;safeRevision:string;at:number;value:Summary;rowid:number;lastActivity?:CaptureEvent;maxObservedAt:number;eventsRef?:WeakRef<CaptureEvent[]>;eventsRowid?:number}|undefined;private usageReader:UsageReader;private hookInstallation:HookInstallation;
  private interval:number; private runId?:string; private reader:typeof callOrca;
  private focusedTabs:FocusedOrcaTab[]=[];private focusedTabsAt=0;
  private lastOrcaAccessibility:AccessibilityCapture|null=null;
  private legacyHookSpools:string[]=[];
  private focusRefresh:Promise<void>|undefined;
  private websiteResolver:WebsiteResolver;private websiteMatches=new Map<string,WebsiteResolution>();private websiteApplied=new Map<string,number>();private websitePending=new Map<string,Promise<void>>();private websiteRevision=0;
  private linear:LinearConnection;
  private privacy:PrivacyExclusions;
  private activityEpoch:string|undefined;
  private clockSample:{wall:number;uptime:number}|undefined;
  private clockShiftSeconds=0;
  private clockNoticeUntil=0;
  private seenSpoolIssues=new Set<string>();
  constructor(output:string,probe?:string,interval=5,runId?:string,reader:typeof callOrca=callOrca,keychainPath=resolve('.capture/bin/linear-keychain')) {
    this.interval=interval;this.runId=runId;this.reader=reader;
    this.output=output;mkdirSync(output,{recursive:true,mode:0o700});this.store=new EventStore(join(output,'events.sqlite'));
    this.activityProbe=new MacActivityProbe(probe,()=>this.surfaces,()=>this.running,line=>this.onProbeLine(line),reason=>{this.lastError=reason;this.macError=reason;if(reason==='macOS helper exited')this.recordCoverage('macos',reason);},()=>{this.macError='macOS activity helper not available';this.recordCoverage('macos','macOS activity helper not available; human activity is unverified');});
    this.websiteResolver=new WebsiteResolver(output);
    this.privacy=new PrivacyExclusions(output);
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
    this.surfaceHistory=this.store.settingsEvents().sort((a,b)=>a.observedAt-b.observedAt);
    this.usageReader=new UsageReader(join(output,'events.sqlite'),undefined,this.reader);this.hookInstallation=new HookInstallation(output);this.syncUsage();
  }
  private syncUsage(){const s=this.surfaces;this.usageReader.configureProviders(Object.fromEntries(agents.map(agent=>[agent.id,s[agent.usageSetting]===true])));if(this.running&&s.tokenUsage&&agents.some(agent=>s[agent.usageSetting]===true))this.usageReader.start();else void this.usageReader.stop();}
  private orcaAvailable(){return this.reader!==callOrca||orcaCliAvailable();}
  status(){const orcaAvailable=this.orcaAvailable();return {running:this.running,orcaAvailable,orcaPolling:this.surfaces.orcaPolling&&orcaAvailable,surfaces:{...this.surfaces},sources:sourceMetadata,lastPoll:this.lastPoll,lastError:this.lastError,eventCount:this.store.count(),macos:this.macos,output:this.output};}
  trayStatus(){const now=new Date(),date=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;const usage=this.usageReader.summary().days.filter(d=>d.date===date);const hooks=this.running?this.hookInstallation.status():null;const outdated=outdatedHookTargets({running:this.running,surfaces:this.surfaces},hooks);const hookWarning=outdated.length&&hooks?{key:hooks.runtimeVersion+':'+outdated.map(target=>target.id).sort().join(','),agents:[...new Set(outdated.map(target=>hooks.agents.find(agent=>agent.id===target.provider)?.name||target.provider))]}:null;const sourceWarning=this.running?this.captureHealth().sources.filter(source=>['stale','failed','repair-needed'].includes(source.state)).map(source=>source.name):[];const summary=this.summary(15000);return {date,running:this.running,...dailyTotals(summary,now),workingAgents:workingAgentCount(summary,now,this.running),tokensToday:usage.reduce((n,d)=>n+d.tokens,0),apiUsdToday:usage.reduce((n,d)=>n+d.usd,0),unpricedToday:usage.reduce((n,d)=>n+d.unpriced,0),hookWarning,sourceWarning};}
  cleanupPreview(){return this.hookInstallation.cleanupPreview();}
  cleanupTracking(){return this.hookInstallation.cleanup();}
  hooksStatus(){return this.hookInstallation.status();}
  captureHealth():CaptureHealth{
    const macos=this.store.recent('macos',16),hookEvents=Object.fromEntries(agents.map(agent=>[agent.id,this.store.recent('hook',24,agent.id)])) as Record<string,CaptureEvent[]>,pollerEvents=Object.fromEntries(pollers.map(source=>[source.id,this.store.recent(source.id,32)])) as Record<string,CaptureEvent[]>,capture=this.store.recent('capture',8);
    const targets=this.hookInstallation.status().targets;
    const hooks=(provider:HookProvider)=>{const own=targets.filter(t=>t.provider===provider);return {installed:own.filter(t=>t.state==='installed').length,total:own.length,needsAttention:own.some(t=>t.state==='needs-update'||t.state==='error')};};
    const currentUrl=typeof this.macos?.browserUrl==='string'?this.macos.browserUrl:null,currentKey=currentUrl?websiteKey(currentUrl,this.websiteResolver.rules()):null;
    const current=currentKey?{key:currentKey,observedAt:Number(this.macos?.observedAt)||0}:undefined;
    const latest={macos:macos[0]?.observedAt||null,...Object.fromEntries(agents.map(agent=>[agent.id,Math.max(0,...targets.filter(target=>target.provider===agent.id).map(target=>target.lastEvent||0))||null])),...Object.fromEntries(pollers.map(source=>[source.id,pollerEvents[source.id][0]?.observedAt||null]))};
    const checkedAt=Date.now()/1000;
    const spool=spoolStatus(join(this.output,'spool'),checkedAt);spool.invalid=Math.max(spool.invalid,this.seenSpoolIssues.size);
    return {checkedAt,latest,hooks:Object.fromEntries(agents.map(agent=>[agent.id,hooks(agent.id)])),sources:sourceStates({running:this.running,surfaces:this.surfaces,orcaAvailable:this.orcaAvailable(),lastPoll:this.lastPoll,failedPoller:this.failedPoller,latest,hooks:{targets},macosTrusted:typeof this.macos?.accessibilityTrusted==='boolean'?this.macos.accessibilityTrusted:null,macosExcluded:this.macos?.excluded===true,macError:this.macError!==null,foregroundBundleId:typeof this.macos?.foregroundBundleId==='string'?this.macos.foregroundBundleId:null,browserDetailAvailable:typeof this.macos?.browserDomain==='string'&&this.macos.browserDomain.length>0,now:checkedAt}),spool,accessibility:this.lastOrcaAccessibility,websites:websiteHealth([...this.websiteMatches.values()],this.websiteApplied,current),events:compactHealthEvents([...macos,...Object.values(hookEvents).flat(),...Object.values(pollerEvents).flat(),...capture])};
  }
  captureChecks(){return captureChecks(this.captureHealth(),this.hookInstallation.status());}
  diagnostics(){
    const bytes=['events.sqlite','events.sqlite-wal'].reduce((total,file)=>{try{return total+statSync(join(this.output,file)).size;}catch{return total;}},0);
    const wall=Date.now()/1000,uptime=process.uptime();
    if(this.clockSample){const delta=(wall-this.clockSample.wall)-(uptime-this.clockSample.uptime);if(Math.abs(delta)>120){this.clockShiftSeconds=delta;this.clockNoticeUntil=wall+600;}}
    if(wall>this.clockNoticeUntil)this.clockShiftSeconds=0;
    this.clockSample={wall,uptime};
    let freeBytes:number|null=null;
    try{const fs=statfsSync(this.output);freeBytes=Number(fs.bavail)*Number(fs.bsize);}catch{/* Disk free space unavailable on this host. */}
    const databaseHealthy=this.store.quickCheck(),health=this.captureHealth();
    const recovery=recoveryNotices({databaseHealthy,freeBytes,sources:health.sources,spool:health.spool,running:this.running,clockShiftSeconds:this.clockShiftSeconds});
    return {...diagnosticSummary({status:this.status(),health,hooks:this.hookInstallation.status(),databaseBytes:bytes,databaseHealthy,now:wall,recovery}),nodeVersion:process.version,platform:process.platform,architecture:process.arch,osVersion:osRelease()};
  }
  exportArchive(){return this.store.exportArchive(this.output);}
  listArchives(){return this.store.listArchives(this.output);}
  deleteArchive(id:string){this.requireOwner();if(pendingReplacement(this.output)?.candidate===id)throw new Error('Cancel the pending replacement before deleting its archive');return this.store.deleteArchive(this.output,id);}
  previewArchive(id:string){return this.store.previewArchive(this.output,id);}
  importArchive(id:string){
    this.requireOwner();
    if(this.running)throw new Error('Pause capture before restoring an archive');
    const result=this.store.importArchive(this.output,id);
    this.usageReader.rebindPricing();
    this.surfaceHistory=this.store.settingsEvents().sort((a,b)=>a.observedAt-b.observedAt);
    this.summaryCache=undefined;
    return result;
  }
  storageUsage(){return storageUsage(this.output);}
  reclaimWal(){this.requireOwner();this.store.checkpointWal();return this.storageUsage();}
  prepareStorageCompaction(){
    if(this.running||this.stopping)throw new Error('Pause capture before preparing storage recovery');
    this.requireOwner();
    return prepareCompaction(this.output,{idleThreshold:this.surfaces.humanIdleMinutes*60,agentIdleThreshold:this.surfaces.agentIdleMinutes*60},()=>this.store.revision());
  }
  prepareStorageRestore(id:string){
    if(this.running||this.stopping)throw new Error('Pause capture before replacing storage');
    this.requireOwner();return prepareRestore(this.output,id);
  }
  cancelStorageReplacement(){this.requireOwner();return cancelPendingReplacement(this.output);}
  storageReplacementStatus(){const pending=pendingReplacement(this.output);return pending?{candidate:pending.candidate,backup:pending.backup,kind:pending.kind}:null;}
  storageReplacementResult(){return replacementResult(this.output);}
  verifyHooks(){return this.hookInstallation.verify();}
  privacyExclusions(){return this.privacy.list();}
  setPrivacyExclusions(entries:PrivacyExclusion[]){
    if(!this.lockOwned&&existsSync(join(this.output,'capture.lock')))throw new Error('Change privacy exclusions in the app that owns capture');
    return this.privacy.replace(entries);
  }
  installHooks(provider:HookProvider,targetIds?:string[]){return this.hookInstallation.install(provider,targetIds);}
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
  previewWebsiteRule(pattern:string,projectPath:string){
    if(!isAbsolute(projectPath))throw new Error('Choose an absolute project directory');
    return previewWebsiteRuleImpact(pattern,projectPathFromWorktree(projectPath),this.summary().intervals,this.websiteResolver.rules());
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
  reviewHistory(){return this.store.reviewActions();}
  private dayReviewSnapshot(date:string,source:Summary){
    const day=summaryForDate(source,date),groups=groupHumanReview(day.intervals),pending=groups.filter(group=>['unmatched','conflict'].includes(humanReviewState(group))),captured=groups.filter(group=>humanReviewState(group)==='captured'),unmatched=pending.filter(group=>humanReviewState(group)==='unmatched'),conflicts=pending.filter(group=>humanReviewState(group)==='conflict'),gaps=unobservedGaps(day.intervals);
    const start=new Date(`${date}T00:00:00`),end=new Date(start);end.setDate(end.getDate()+1);
    const issues=dailyCaptureIssues(source,start.getTime()/1000,end.getTime()/1000);
    const fingerprint=createHash('sha256').update(JSON.stringify({intervals:day.intervals,issues,notes:this.store.manualNotes(date)})).digest('hex');
    const saved=this.store.dayReview(date);
    return {date,completedAt:saved?.completedAt||null,stale:Boolean(saved&&saved.fingerprint!==fingerprint),hasActivity:day.intervals.length>0,pendingGroups:pending.length,capturedGroups:captured.length,unmatchedSeconds:unmatched.reduce((total,group)=>total+group.seconds,0),conflicts:conflicts.length,gaps:gaps.length,fingerprint};
  }
  dayReviewStatus(date:string){
    const summary=this.summary(),start=new Date(`${date}T00:00:00`),earliest=new Date(start),latest=new Date(start);
    earliest.setDate(earliest.getDate()-7);latest.setDate(latest.getDate()+1);
    const from=earliest.getTime()/1000,to=latest.getTime()/1000;
    // One scan of the complete history keeps day review responsive on large databases.
    const recent={...summary,intervals:summary.intervals.filter(item=>item.end>from&&item.start<to),coverage:summary.coverage.filter(item=>item.observedAt!==undefined&&item.observedAt>=from&&item.observedAt<to),unresolved:summary.unresolved.filter(item=>item.observedAt!==undefined&&item.observedAt>=from&&item.observedAt<to)};
    const current=this.dayReviewSnapshot(date,recent),backlog=[];
    for(let days=1;days<=7;days++){const prior=new Date(start);prior.setDate(prior.getDate()-days);const key=`${prior.getFullYear()}-${String(prior.getMonth()+1).padStart(2,'0')}-${String(prior.getDate()).padStart(2,'0')}`;const item=this.dayReviewSnapshot(key,recent);if(item.hasActivity&&(!item.completedAt||item.stale))backlog.push({date:key,unmatchedSeconds:item.unmatchedSeconds,conflicts:item.conflicts,gaps:item.gaps});}
    const {fingerprint:_,...view}=current;return {...view,backlog};
  }
  markDayReview(date:string){
    if(!this.lockOwned&&existsSync(join(this.output,'capture.lock')))throw new Error('Review activity in the app that owns capture');
    const snapshot=this.dayReviewSnapshot(date,this.summary());if(!snapshot.hasActivity)throw new Error('There is no captured activity to review for this day');
    if(snapshot.pendingGroups)throw new Error(`Review ${snapshot.pendingGroups} remaining activity groups before marking this day reviewed`);
    this.store.markDayReview(date,snapshot.fingerprint);return this.dayReviewStatus(date);
  }
  undoReviewAction(id:string):Summary{
    if(!this.lockOwned&&existsSync(join(this.output,'capture.lock')))throw new Error('Review activity in the app that owns capture');
    this.store.undoReviewAction(id);this.summaryCache=undefined;return this.summary();
  }
  setHumanGroupSplit(pairs:Array<[string,string]>,splitAt:number,beforeProject?:string,afterProject?:string):Summary{
    if(!this.lockOwned&&existsSync(join(this.output,'capture.lock')))throw new Error('Review activity in the app that owns capture');
    if(!Array.isArray(pairs)||!pairs.length||pairs.length>500||!Number.isFinite(splitAt))throw new Error('Invalid activity split');
    if(pairs.some(pair=>!Array.isArray(pair)||pair.length!==2||pair.some(id=>typeof id!=='string'||!id||id.length>128)))throw new Error('Invalid activity split');
    const unique=[...new Map(pairs.map(pair=>[pair.join(':'),pair])).values()];
    const ranges=new Map<string,[number,number]>();
    for(const interval of this.summary().intervals.filter(item=>item.state==='human')){
      const key=humanIntervalKey(interval);if(!key)continue;const old=ranges.get(key);ranges.set(key,old?[Math.min(old[0],interval.start),Math.max(old[1],interval.end)]:[interval.start,interval.end]);
    }
    const bounds=unique.map(pair=>ranges.get(pair.join(':')));
    if(bounds.some(range=>!range))throw new Error('Activity changed; refresh and try again');
    const valid=bounds as Array<[number,number]>,start=Math.min(...valid.map(range=>range[0])),end=Math.max(...valid.map(range=>range[1]));
    if(splitAt<=start||splitAt>=end||splitAt-start<1||end-splitAt<1)throw new Error('Choose a time inside this activity');
    const normalize=(value?:string)=>{
      if(!value)return null;
      if(!isAbsolute(value))throw new Error('Choose an absolute project directory');
      const path=projectPathFromWorktree(value);if(!existsSync(path)||!statSync(path).isDirectory())throw new Error('Choose an existing project directory');return path;
    };
    const before=normalize(beforeProject),after=normalize(afterProject);
    if(before===after)throw new Error('Choose different projects or leave one side unassigned');
    this.store.setHumanGroupSplit(unique,splitAt,valid,before,after);this.summaryCache=undefined;return this.summary();
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
    const next={...this.surfaces,...patch} as CaptureSettings;
    if(Object.keys(defaultSettings).every(k=>next[k as keyof CaptureSettings]===this.surfaces[k as keyof CaptureSettings]))return this.status();
    const browserChanged=browsers.some(source=>next[source.setting]!==this.surfaces[source.setting]);
    if(this.lockOwned)this.drainHooks();
    const path=join(this.output,'settings.json'),existing=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{};
    writeFileSync(path+'.tmp',JSON.stringify({...existing,...next},null,2)+'\n',{mode:0o600});renameSync(path+'.tmp',path);
    const change=makeEvent('capture','capture_settings',{data:{previous:{...this.surfaces},surfaces:next}});
    this.store.put(change);this.surfaceHistory.push(change);this.surfaces=next;this.revision++;this.summaryCache=undefined;
    if(!next.macosActivity||browserChanged){this.activityProbe.stop();this.macos=null;if(!next.macosActivity){this.focusedTabs=[];this.focusedTabsAt=0;}}
    if(this.running&&next.macosActivity&&!this.activityProbe.active)this.activityProbe.start();
    this.syncUsage();
    if(this.running&&!this.inFlight){clearTimeout(this.timer);void this.tick();}
    return this.status();
  }
  private acceptHook(event:CaptureEvent){
    const key=agentById.get(event.provider||'')?.setting;
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
  private onProbeLine(line:string){
    let saving=false;
    try{
      const payload=JSON.parse(line);
      if(this.privacy.matches(payload,browserByBundle.has(String(payload.foregroundBundleId)))){
        // No excluded sample is stored. A new epoch prevents the next visible
        // sample from crediting the gap across private foreground activity.
        if(this.macos?.excluded!==true)this.activityEpoch=randomUUID();
        this.macos={excluded:true,observedAt:Date.now()/1000};this.macError=null;return;
      }
      if(!browserEnabled(this.surfaces,payload.foregroundBundleId)){delete payload.browserDomain;delete payload.browserUrl;delete payload.browserTitle;}
      const event=normalizeActivity(payload,{hostId:'local'});
      if(this.activityEpoch)event.collectorEpoch=this.activityEpoch;
      const browserUrl=event.data?.browserUrl;
      if(typeof browserUrl==='string'){
        const key=websiteKey(browserUrl,this.websiteResolver.rules()),match=key?this.websiteMatches.get(key):undefined;
        if(match&&Date.now()/1000-match.observedAt<5&&match.projectPath){event.workspaceId=match.workspaceId;event.data={...event.data,websiteAttribution:{source:match.source,projectPath:match.projectPath,detail:match.detail}};if(key){this.websiteApplied.set(key,event.observedAt);if(this.websiteApplied.size>200)this.websiteApplied.delete(this.websiteApplied.keys().next().value!);}}
        if(!match||Date.now()/1000-match.observedAt>=3)this.resolveWebsite(browserUrl);
      }
      const foreground=pollers.map(source=>source.foreground?.(payload,event,this.focusedTabs,this.focusedTabsAt)).find(Boolean);
      this.macos={...payload,orcaAttribution:foreground?.attribution||null,websiteAttribution:event.data?.websiteAttribution||null};
      if(foreground?.accessibility)this.lastOrcaAccessibility=foreground.accessibility;
      saving=true;this.store.put(event);this.macError=null;
    }catch(error){this.lastError=saving?`Could not save macOS observation: ${String(error)}`:'Invalid macOS observation';this.macError=this.lastError;}
  }
  private recordCoverage(source:'macos'|'capture',reason:string){
    try{this.store.put(makeEvent(source,'coverage',{data:{reason}}));}
    catch(error){this.lastError=`Could not save ${source} coverage: ${String(error)}`;if(source==='macos')this.macError=this.lastError;}
  }
  private refreshProbeTrust():Promise<void>|undefined{return this.activityProbe.refreshTrust(this.macos);}
  summary(maxAgeMs=0):Summary {
    const revision=this.store.revision();if(this.summaryCache&&(this.summaryCache.revision===revision||maxAgeMs>0&&Date.now()-this.summaryCache.at<maxAgeMs))return this.summaryCache.value;
    const previous=this.summaryCache,safeRevision=this.store.incrementalSafetyRevision();
    let newRows:ReturnType<EventStore['eventsAfterRowid']>|undefined;
    if(previous&&previous.safeRevision===safeRevision){
      newRows=this.store.eventsAfterRowid(previous.rowid);const newEvents=newRows.map(row=>row.event);
      if(newEvents.length&&newEvents.every(event=>event.observedAt>=previous.maxObservedAt)&&newEvents.every((event,index)=>index===0||event.observedAt>=newEvents[index-1]!.observedAt)){
        const value=appendActivitySummary(previous.value,previous.lastActivity,newEvents,this.surfaces.humanIdleMinutes*60);
        if(value){this.summaryCache={revision,safeRevision,at:Date.now(),value,rowid:newRows.at(-1)!.rowid,lastActivity:newEvents.at(-1),maxObservedAt:newEvents.at(-1)!.observedAt,eventsRef:previous.eventsRef,eventsRowid:previous.eventsRowid};return value;}
      }
    }
    // The reducer still replays all events for hook and Orca changes. Reuse the
    // parsed prefix while it survives GC, avoiding a full SQLite read and JSON
    // decode on every replay without permanently retaining a large history.
    const cached=previous?.safeRevision===safeRevision?previous.eventsRef?.deref():undefined;
    const eventRows=cached&&previous?.eventsRowid!==undefined?previous.eventsRowid===previous.rowid?newRows||this.store.eventsAfterRowid(previous.eventsRowid):this.store.eventsAfterRowid(previous.eventsRowid):undefined;
    const events=cached&&eventRows?[...cached,...eventRows.map(row=>row.event)]:this.store.events();
    const summary=applyHumanDecisions(summarize(events,{idleThreshold:this.surfaces.humanIdleMinutes*60,agentIdleThreshold:this.surfaces.agentIdleMinutes*60}),this.store.humanDecisions(),this.store.humanSplits());
    const terminals=new Map(events.filter(e=>e.kind==='terminal').map(e=>[e.terminalHandle,e]));
    for(const s of summary.sessions){const t=terminals.get(s.terminalHandle);if(t&&!s.child){s.title=String(t.data?.title||s.title).replace(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✳◐◓◑◒]\s*/, '');s.cwd=t.cwd||s.cwd;}}
    let lastActivity:CaptureEvent|undefined,maxObservedAt=-Infinity;
    for(const event of events){
      maxObservedAt=Math.max(maxObservedAt,event.observedAt);
      if(event.source==='macos'&&event.kind==='activity')lastActivity=event;
      else if(['sleep','capture_stop','capture_start'].includes(event.kind)||event.kind==='capture_settings'&&event.data?.previous&&event.data?.surfaces&&(event.data.previous as Record<string,unknown>).macosActivity!==(event.data.surfaces as Record<string,unknown>).macosActivity)lastActivity=undefined;
    }
    const rowid=this.store.lastEventRowid();
    this.summaryCache={revision,safeRevision:this.store.incrementalSafetyRevision(),at:Date.now(),value:summary,rowid,lastActivity,maxObservedAt,eventsRef:new WeakRef(events),eventsRowid:rowid};return summary;
  }
  summaryForDate(date:string,maxAgeMs=0):Summary{return summaryForDate(this.summary(maxAgeMs),date);}
  weeklyReview(startDate:string){
    const summary=this.summary(15000),start=new Date(`${startDate}T00:00:00`),accepted=new Set<string>();
    if(!Number.isNaN(start.getTime()))for(let offset=0;offset<7;offset++){
      const day=new Date(start);day.setDate(day.getDate()+offset);
      const date=`${day.getFullYear()}-${String(day.getMonth()+1).padStart(2,'0')}-${String(day.getDate()).padStart(2,'0')}`;
      const snapshot=this.dayReviewSnapshot(date,summary);
      if(snapshot.completedAt&&!snapshot.stale&&!snapshot.pendingGroups)accepted.add(date);
    }
    return weeklyReview(summary,startDate,accepted);
  }
  workOutcomes(date:string){return localWorkOutcomes(this.summary(15000),date);}
  manualNotes(date:string){return this.store.manualNotes(date);}
  addManualNote(input:Omit<ManualNote,'id'|'createdAt'>){this.requireOwner();return this.store.addManualNote(input);}
  removeManualNote(id:string){this.requireOwner();return this.store.removeManualNote(id);}
  private requireOwner(){if(!this.lockOwned&&existsSync(join(this.output,'capture.lock')))throw new Error('Edit manual notes in the app that owns capture');}
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
    writeFileSync(lock,String(process.pid),{mode:0o600,flag:'wx'});this.lockOwned=true;this.running=true;this.lastError=null;this.failedPoller=null;this.macError=null;
    try{
      this.store.put(makeEvent('capture','capture_start'));
      this.activityProbe.start();
      this.syncUsage();
      if(durationSeconds!==undefined)this.deadline=setTimeout(()=>{void this.stop();},durationSeconds*1000);
      await this.tick();return this.status();
    }catch(error){
      this.running=false;this.activityProbe.stop();clearTimeout(this.deadline);
      if(existsSync(lock)&&readFileSync(lock,'utf8')===String(process.pid))unlinkSync(lock);
      this.lockOwned=false;throw error;
    }
  }
  private async tick() {
    if(!this.running)return;
    this.inFlight=this.poll().catch(error=>{this.lastError=`Capture poll failed: ${String(error)}`;});
    await this.inFlight;this.inFlight=undefined;
    if(this.running)this.timer=setTimeout(()=>{void this.tick();},this.interval*1000);
  }
  private refreshFocusedTabs(){
    if(this.focusRefresh||!this.running||!this.surfaces.macosActivity||!this.orcaAvailable())return;
    this.focusRefresh=(async()=>{
      try{const receipt=await this.reader(['terminal','list','--include-visual-layouts','--limit','1000','--json']);if(this.running&&this.surfaces.macosActivity){this.focusedTabs=tabIndexFromTerminalList(receipt);this.focusedTabsAt=Date.now();}}
      catch{this.focusedTabs=[];this.focusedTabsAt=0;}
    })().finally(()=>{this.focusRefresh=undefined;});
  }
  private async poll() {
    try{
      let pollingError:string|null=null,failedPoller:string|null=null;
      void this.refreshProbeTrust();
      const orcaAvailable=this.orcaAvailable();
      if(orcaAvailable)this.refreshFocusedTabs();
      else {this.focusedTabs=[];this.focusedTabsAt=0;}
      for(const source of pollers.filter(source=>this.surfaces[source.setting]&&(source.id!=='orca'||orcaAvailable))){
        const revision=this.revision,valid=()=>this.running&&this.surfaces[source.setting]===true&&this.revision===revision;
        const error=await source.poll({reader:this.reader,runId:this.runId,valid,store:this.store});
        if(valid()&&error&&!pollingError){pollingError=error;failedPoller=source.id;}
      }
      const spoolIssues=this.drainHooks(),currentIssues=new Set(spoolIssues.map(issue=>issue.reason));
      for(const issue of spoolIssues)if(!this.seenSpoolIssues.has(issue.reason))this.store.put(makeEvent('hook','coverage',{data:{reason:issue.reason}}));
      this.seenSpoolIssues=currentIssues;
      this.lastPoll=Date.now()/1000;this.lastError=pollingError;this.failedPoller=failedPoller;
    }catch(error){this.lastError=String(error);this.failedPoller=null;this.recordCoverage('capture',this.lastError);}
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
    this.activityProbe.stop();
    await this.usageReader.stop();
    await this.inFlight;
    try{this.drainHooks();this.store.put(makeEvent('capture','capture_stop'));}
    catch(error){this.lastError=`Could not finish capture cleanly: ${String(error)}`;}
    finally{if(this.lockOwned){const lock=join(this.output,'capture.lock');if(existsSync(lock)&&readFileSync(lock,'utf8')===String(process.pid))unlinkSync(lock);this.lockOwned=false;}}
    return this.status();
  }
  async close(){this.linear.close();await this.stop();await this.usageReader.close();this.store.close();}
}
