import {cleanupArchiveStaging} from './archive-storage.ts';
import {storagePolicyDecision,quickStorageUsage,estimatedBytes} from './storage-policy.ts';
import { mkdirSync, existsSync, writeFileSync, readFileSync, unlinkSync, renameSync, lstatSync, statSync, statfsSync, readdirSync } from 'node:fs';
import { join, isAbsolute, basename, resolve } from 'node:path';
import {createHash} from 'node:crypto';
import { EventStore, MAX_DECISION_PAIRS, type ManualNote } from './store.ts';
import { makeEvent, type Summary, type CaptureEvent } from './events.ts';
import { defaultSettings, validateSettings, storedSettings, browserEnabled, type CaptureSettings } from './settings.ts';
import { callOrca,orcaCliAvailable } from './orca.ts';
import { importSpool,spoolStatus,acknowledgeSpoolOverflow,claimSpoolOverflow,spoolOverflowReason } from './hooks.ts';
import {validAgentReport} from '../mcp/report.ts';
import {creditTaskCounters,reportedWorkForDay} from './reported-work.ts';
import {applyReportedResources,reportedResources,type ReportedResource} from './reported-resources.ts';
import { normalizeActivity,MacActivityProbe } from './macos.ts';
import {resolveOrcaTab,tabIndexFromTerminalList,type FocusedOrcaTab} from './orca-focus.ts';
import { summarize } from './correlate.ts';
import { dailyTotals,summaryForDate,recentWorkingAgentCount } from './daily.ts';
import {UsageReader} from '../usage/reader.ts';
import {HookInstallation,type HookInstallationStatus,type HookProvider} from './hook-installation.ts';
import {McpInstallation} from './mcp-installation.ts';
import {ClaudeStatusLineInstallation} from './claude-statusline-installation.ts';
import {compactHealthEvents,websiteHealth,type CaptureHealth,type AccessibilityCapture} from './health.ts';
import {WebsiteResolver,websiteKey,projectPathFromWorktree,previewWebsiteRuleImpact,type KnownWorkspace,type WebsiteResolution} from './website-resolver.ts';
import {LinearConnection,keychainHelper} from './linear.ts';
import {applyHumanDecisions,groupHumanReview,humanIntervalKey,humanReviewState,type HumanDecision,type HumanSplit} from './human-review.ts';
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
import {prepareCompactionAsync,prepareRestore,cancelPendingReplacement,pendingReplacement,replacementResult} from './storage-migration.ts';
import {runStorageTask} from './storage-worker.ts';
import {DaySummaries,applyTerminalTitles} from './day-summaries.ts';
import {staticOrcaScopeReason} from './observation-retention.ts';
import {addDays,localDate,localDayBounds,windowBounds} from './summary-window.ts';
import {release as osRelease} from 'node:os';
import {randomUUID} from 'node:crypto';
import {clearStaleLock,ownsLock,writeLock} from './capture-lock.ts';

// The tray asks every few seconds; installation status reads configs and runtime files.
const hookStatusTtlMs=30_000;
// Orca tab layouts change rarely; refresh them at most this often unless a tab is unknown.
const focusRefreshMs=15_000;
const focusMissRefreshMs=3_000;
// A matched website keeps attributing samples this long, and is rechecked after the shorter delay.
const websiteMatchFreshSeconds=30;
const websiteRecheckSeconds=10;
// An ongoing problem is recorded once; a recurrence after this long is recorded again.
const coverageRepeatMs=10*60_000;
const knownWorkspacesTtlMs=5*60_000;
const exportTemporaryAgeMs=60*60_000;

const reviewIssues=(day:Summary)=>[...day.coverage,...day.unresolved].filter(issue=>issue.reason!==staticOrcaScopeReason);
function sortedByJson<T>(items:T[]):T[]{return items.map(item=>[JSON.stringify(item),item] as const).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0).map(([,item])=>item);}
function reviewFingerprint(intervals:unknown[],issues:unknown[],notes:unknown[]){return createHash('sha256').update(JSON.stringify({intervals,issues,notes})).digest('hex');}
/** Prefix of order-independent fingerprints; unprefixed ones come from earlier versions. */
const FINGERPRINT_VERSION='v2:';
/** Stored after a failed legacy check so the costly check is never repeated. */
/** Bump when the review snapshot logic changes, to drop cached snapshots. */
const DAY_REVIEW_CACHE_VERSION='r2';
const LEGACY_STALE_FINGERPRINT=`${FINGERPRINT_VERSION}legacy-stale`;

export class Collector {
  readonly output:string; readonly store:EventStore;
  private running=false; private timer:ReturnType<typeof setTimeout>|undefined; private deadline:ReturnType<typeof setTimeout>|undefined;
  private activityProbe:MacActivityProbe; private inFlight:Promise<void>|undefined; private lastPoll:number|null=null;
  private lastError:string|null=null; private macos:Record<string,unknown>|null=null; private lockOwned=false;
  private failedPoller:string|null=null; private macError:string|null=null;
  private stopping:Promise<ReturnType<Collector['status']>>|undefined;
  private surfaces:CaptureSettings={...defaultSettings};private resourceCache?:{at:number;value:Map<string,ReportedResource>};private summaryTokens=new WeakMap<Summary,string>();private summaryTokenCount=0;private summaryEpoch=Date.now().toString(36);private derivedMemo?:{day:Summary;resources:Map<string,ReportedResource>;counters:string;value:Summary}; private revision=0;
  private surfaceHistory:CaptureEvent[]=[];
  /** Whole-history summary, only for callers that ask without a date. */
  private summaryCache:{revision:string;at:number;value:Summary}|undefined;
  private days:DaySummaries;
  private reviewCache:{revision:string;decisions:HumanDecision[];splits:HumanSplit[]}|undefined;
  private decorated=new Map<string,{key:string;value:Summary;day?:Summary}>();
  private usageReader:UsageReader;private hookInstallation:HookInstallation;private mcpInstallation:McpInstallation;private claudeStatusLine:ClaudeStatusLineInstallation;
  private hookStatusCache:{at:number;value:HookInstallationStatus}|undefined;
  private interval:number; private runId?:string; private reader:typeof callOrca;
  private focusedTabs:FocusedOrcaTab[]=[];private focusedTabsAt=0;private focusRequestedAt=0;
  private terminalReceipt:{at:number;promise:Promise<unknown>}|undefined;
  private pollerMemory=new Map<string,Record<string,unknown>>();
  private coverageActive=new Set<string>();private coverageSeen=new Set<string>();private coverageRecordedAt=new Map<string,number>();
  private lastOrcaAccessibility:AccessibilityCapture|null=null;
  private legacyHookSpools:string[]=[];
  private focusRefresh:Promise<void>|undefined;
  private websiteResolver:WebsiteResolver;private websiteMatches=new Map<string,WebsiteResolution>();private websiteApplied=new Map<string,number>();private websitePending=new Map<string,Promise<void>>();private websiteRevision=0;
  private knownWorkspaceCache:{at:number;value:KnownWorkspace[]}|undefined;
  private linear:LinearConnection;
  private privacy:PrivacyExclusions;
  private activityEpoch:string|undefined;
  private clockSample:{wall:number;uptime:number}|undefined;
  private clockShiftSeconds=0;
  private clockNoticeUntil=0;
  private seenSpoolIssues=new Set<string>();
  private storageTask:Promise<unknown>|undefined;
  private careTimer:ReturnType<typeof setTimeout>|undefined;
  private starting=false;private startEpoch=0;private checkingStorage=false;
  private nextStorageCheck=0;private nextArchiveCare=0;
  private careState:{at:number|null;error:string|null}={at:null,error:null};
  private scheduleStorageCare(delay=60000){clearTimeout(this.careTimer);if(this.running)this.careTimer=setTimeout(()=>{void this.performStorageCare().finally(()=>this.scheduleStorageCare());},delay).unref();}
  private async performStorageCare(forceArchives=false){
    if(!this.lockOwned||this.storageTask||pendingReplacement(this.output))return;
    try{await this.exclusiveStorageTask(()=>runStorageTask({op:'care',database:join(this.output,'events.sqlite'),output:this.output,now:Date.now()/1000,archives:forceArchives||Date.now()>=this.nextArchiveCare}));if(forceArchives||Date.now()>=this.nextArchiveCare)this.nextArchiveCare=Date.now()+86400000;this.careState={at:Date.now()/1000,error:null};}
    catch(error){this.careState={at:Date.now()/1000,error:String(error)};}
  }
  private async ensureStorageCapacity():Promise<boolean>{
    let usage=quickStorageUsage(this.output),decision=storagePolicyDecision(usage,this.surfaces.storageLimitMB);
    if(decision!=='ok'&&!this.storageTask&&!pendingReplacement(this.output)){await this.performStorageCare(true);usage=quickStorageUsage(this.output);decision=storagePolicyDecision(usage,this.surfaces.storageLimitMB);}
    const path=join(this.output,'storage-paused.json');
    if(decision!=='pause'&&!usage.truncated){if(existsSync(path))unlinkSync(path);return true;}
    const reason=usage.truncated?'Storage measurement reached its safety limit. Clear the hook backlog before resuming.':usage.freeBytes!==null&&usage.freeBytes<1024**3?'Capture paused to keep 1 GB of disk space free. Free disk space, then resume.':'Capture paused at your storage budget. Increase the budget or remove a verified backup, then resume.';
    const temp=path+'.tmp';writeFileSync(temp,JSON.stringify({reason,at:Date.now()/1000}),{mode:0o600});renameSync(temp,path);this.lastError=reason;return false;
  }
  /** Problems found while opening the data directory; capture continues with safe defaults. */
  private startupIssues:string[]=[];
  private legacySummaryRelease:ReturnType<typeof setTimeout>|undefined;
  private legacyFingerprintChecked=new Set<string>();
  constructor(output:string,probe?:string,interval=5,runId?:string,reader:typeof callOrca=callOrca,keychainPath=resolve('.capture/bin/linear-keychain')) {
    this.interval=interval;this.runId=runId;this.reader=reader;
    this.output=output;mkdirSync(output,{recursive:true,mode:0o700});this.store=new EventStore(join(output,'events.sqlite'));
    this.activityProbe=new MacActivityProbe(probe,()=>this.surfaces,()=>this.running,line=>this.onProbeLine(line),reason=>{this.lastError=reason;this.macError=reason;if(reason==='macOS helper exited')this.recordCoverage('macos',reason);},()=>{this.macError='macOS activity helper not available';this.recordCoverage('macos','macOS activity helper not available; human activity is unverified');});
    this.websiteResolver=new WebsiteResolver(output);
    this.privacy=new PrivacyExclusions(output);
    if(this.privacy.issue)this.startupIssues.push(this.privacy.issue);
    this.linear=new LinearConnection(output,keychainHelper(keychainPath));
    this.loadSettings();
    this.surfaceHistory=this.store.settingsEvents().sort((a,b)=>a.observedAt-b.observedAt);
    this.days=new DaySummaries(this.store,()=>this.summaryOptions());
    // Share the store's connection: a second connection's commits would look
    // like foreign writes and invalidate every summary cache once a minute.
    this.usageReader=new UsageReader(this.store.database,undefined,this.reader);this.hookInstallation=new HookInstallation(output);this.mcpInstallation=new McpInstallation(output);this.claudeStatusLine=new ClaudeStatusLineInstallation(output);this.syncUsage();
    this.removeStaleExportTemporaries();
  }
  private loadSettings(){
    const settings=join(this.output,'settings.json');
    if(!existsSync(settings))return;
    let config:Record<string,unknown>;
    try{
      const parsed=JSON.parse(readFileSync(settings,'utf8'));
      if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('Settings must be a JSON object');
      config=parsed;this.surfaces=storedSettings(config);
    }catch(error){
      // Damaged settings must not stop capture. Keep the file for inspection and use defaults.
      this.surfaces={...defaultSettings};
      try{renameSync(settings,settings+'.corrupt');}catch{/* The notice still reports the reset. */}
      this.startupIssues.push(`Settings were unreadable and were reset to defaults; the damaged file was kept as settings.json.corrupt (${error instanceof Error?error.message:String(error)})`);
      return;
    }
    if(Array.isArray(config.legacyHookSpools)){
      const candidates:unknown[]=config.legacyHookSpools;
      this.legacyHookSpools=[...new Set(candidates.filter((p):p is string=>typeof p==='string'&&isAbsolute(p)&&basename(p)==='spool').map(p=>resolve(p)).filter(p=>p!==resolve(this.output,'spool')))];
    }
  }
  /** Report a problem met before the collector was created, such as a failed storage replacement. */
  noteStartupIssue(issue:string){this.startupIssues.push(issue);}
  private removeStaleExportTemporaries(){
    try{cleanupArchiveStaging(this.output);}catch(error){this.startupIssues.push(`Archive staging cleanup could not finish: ${String(error)}`);}
    // An interrupted export leaves a .tmp copy of the whole database behind.
    const folder=join(this.output,'exports');
    try{
      if(!existsSync(folder)||lstatSync(folder).isSymbolicLink())return;
      for(const name of readdirSync(folder)){
        if(!/^agent-time-.*\.sqlite(?:\.gz\.[a-f0-9-]+)?\.tmp$/.test(name))continue;
        const path=join(folder,name),info=lstatSync(path);
        if(info.isFile()&&Date.now()-info.mtimeMs>exportTemporaryAgeMs)unlinkSync(path);
      }
    }catch{/* Cleanup is best effort. */}
  }
  private summaryOptions(){return {idleThreshold:this.surfaces.humanIdleMinutes*60,agentIdleThreshold:this.surfaces.agentIdleMinutes*60};}
  private syncUsage(){const s=this.surfaces;this.usageReader.configureProviders(Object.fromEntries(agents.map(agent=>[agent.id,s[agent.usageSetting]===true])));if(this.running&&s.tokenUsage&&agents.some(agent=>s[agent.usageSetting]===true))this.usageReader.start();else void this.usageReader.stop();}
  private orcaAvailable(){return this.reader!==callOrca||orcaCliAvailable();}
  private currentWorkingAgents(now=Date.now()/1000){return this.running?recentWorkingAgentCount(this.surfaces.orcaPolling?this.store.recent('orca',100):[],this.store.recent('hook',100).filter(event=>agents.some(agent=>agent.id===event.provider&&this.surfaces[agent.setting])),now):0;}
  status(){const orcaAvailable=this.orcaAvailable();return {running:this.running,orcaAvailable,orcaPolling:this.surfaces.orcaPolling&&orcaAvailable,surfaces:{...this.surfaces},sources:sourceMetadata,lastPoll:this.lastPoll,lastError:this.lastError,eventCount:this.store.count(),workingAgents:this.currentWorkingAgents(),macos:this.macos,output:this.output,storageCare:{...this.careState,paused:existsSync(join(this.output,'storage-paused.json'))},startupIssues:[...this.startupIssues]};}
  trayStatus(){
    const now=new Date(),date=localDate(now.getTime()/1000);
    // Token usage is read only when the user enabled it.
    const usage=this.surfaces.tokenUsage?this.usageReader.summary().days.filter(d=>d.date===date):[];
    const hooks=this.running?this.cachedHookStatus():null;
    const outdated=outdatedHookTargets({running:this.running,surfaces:this.surfaces},hooks);
    const hookWarning=outdated.length&&hooks?{key:hooks.runtimeVersion+':'+outdated.map(target=>target.id).sort().join(','),agents:[...new Set(outdated.map(target=>hooks.agents.find(agent=>agent.id===target.provider)?.name||target.provider))]}:null;
    const sourceWarning=this.running?this.captureHealth().sources.filter(source=>['stale','failed','repair-needed'].includes(source.state)).map(source=>source.name):[];
    const summary=this.daySummary(date,60000);
    return {date,running:this.running,...dailyTotals(summary,now),workingAgents:this.currentWorkingAgents(now.getTime()/1000),tokensToday:usage.reduce((n,d)=>n+d.tokens,0),apiUsdToday:usage.reduce((n,d)=>n+d.usd,0),unpricedToday:usage.reduce((n,d)=>n+d.unpriced,0),hookWarning,sourceWarning};
  }
  private cachedHookStatus():HookInstallationStatus{
    if(this.hookStatusCache&&Date.now()-this.hookStatusCache.at<hookStatusTtlMs)return this.hookStatusCache.value;
    return this.freshHookStatus();
  }
  private freshHookStatus():HookInstallationStatus{
    const value=this.hookInstallation.status();this.hookStatusCache={at:Date.now(),value};return value;
  }
  private afterHookChange<T>(value:T):T{this.hookStatusCache=undefined;return value;}
  cleanupPreview(){return this.hookInstallation.cleanupPreview();}
  cleanupTracking(){return this.afterHookChange(this.hookInstallation.cleanup());}
  hooksStatus(){return this.freshHookStatus();}
  mcpStatus(){return this.mcpInstallation.status();}
  installMcp(provider:'claude'|'codex',targetIds?:string[]){return this.mcpInstallation.install(provider,targetIds);}
  removeMcp(provider:'claude'|'codex',targetIds?:string[]){return this.mcpInstallation.remove(provider,targetIds);}
  claudeStatusLineStatus(){return this.claudeStatusLine.status();}
  installClaudeStatusLine(targetId:string){return this.claudeStatusLine.install(targetId);}
  removeClaudeStatusLine(targetId:string){return this.claudeStatusLine.remove(targetId);}
  captureHealth():CaptureHealth{
    const macos=this.store.recent('macos',16),hookEvents=Object.fromEntries(agents.map(agent=>[agent.id,this.store.recent('hook',24,agent.id)])) as Record<string,CaptureEvent[]>,pollerEvents=Object.fromEntries(pollers.map(source=>[source.id,this.store.recent(source.id,32)])) as Record<string,CaptureEvent[]>,capture=this.store.recent('capture',8);
    const targets=this.cachedHookStatus().targets;
    const hooks=(provider:HookProvider)=>{const own=targets.filter(t=>t.provider===provider);return {installed:own.filter(t=>t.state==='installed').length,total:own.length,needsAttention:own.some(t=>t.state==='needs-update'||t.state==='error')};};
    const currentUrl=typeof this.macos?.browserUrl==='string'?this.macos.browserUrl:null,currentKey=currentUrl?websiteKey(currentUrl,this.websiteResolver.rules()):null;
    const current=currentKey?{key:currentKey,observedAt:Number(this.macos?.observedAt)||0}:undefined;
    const latest={macos:macos[0]?.observedAt||null,...Object.fromEntries(agents.map(agent=>[agent.id,Math.max(0,...targets.filter(target=>target.provider===agent.id).map(target=>target.lastEvent||0))||null])),...Object.fromEntries(pollers.map(source=>[source.id,pollerEvents[source.id][0]?.observedAt||null]))};
    const checkedAt=Date.now()/1000;
    const spool=spoolStatus(join(this.output,'spool'),checkedAt);spool.invalid=Math.max(spool.invalid,this.seenSpoolIssues.size);
    return {checkedAt,latest,hooks:Object.fromEntries(agents.map(agent=>[agent.id,hooks(agent.id)])),sources:sourceStates({running:this.running,surfaces:this.surfaces,orcaAvailable:this.orcaAvailable(),lastPoll:this.lastPoll,failedPoller:this.failedPoller,latest,hooks:{targets},macosTrusted:typeof this.macos?.accessibilityTrusted==='boolean'?this.macos.accessibilityTrusted:null,macosExcluded:this.macos?.excluded===true,macError:this.macError!==null,foregroundBundleId:typeof this.macos?.foregroundBundleId==='string'?this.macos.foregroundBundleId:null,browserDetailAvailable:typeof this.macos?.browserDomain==='string'&&this.macos.browserDomain.length>0,now:checkedAt}),spool,accessibility:this.lastOrcaAccessibility,websites:websiteHealth([...this.websiteMatches.values()],this.websiteApplied,current),events:compactHealthEvents([...macos,...Object.values(hookEvents).flat(),...Object.values(pollerEvents).flat(),...capture])};
  }
  captureChecks(){return captureChecks(this.captureHealth(),this.freshHookStatus());}
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
    return {...diagnosticSummary({status:this.status(),health,hooks:this.freshHookStatus(),databaseBytes:bytes,databaseHealthy,now:wall,recovery}),nodeVersion:process.version,platform:process.platform,architecture:process.arch,osVersion:osRelease()};
  }
  exportArchive(){return this.exclusiveStorageTask(()=>runStorageTask<{path:string;bytes:number;events:number}>({op:'export',database:join(this.output,'events.sqlite'),output:this.output}));}
  listArchives(){return this.store.listArchives(this.output);}
  deleteArchive(id:string){this.requireOwner();if(this.storageTask)throw new Error('Wait for the storage operation to finish before deleting an archive');if(pendingReplacement(this.output)?.candidate===id)throw new Error('Cancel the pending replacement before deleting its archive');return this.store.deleteArchive(this.output,id);}
  previewArchive(id:string){return this.exclusiveStorageTask(()=>runStorageTask({op:'preview',database:join(this.output,'events.sqlite'),output:this.output,id}));}
  /** Runs off the request thread so other requests are answered while a large archive imports. */
  async importArchive(id:string){
    this.requireOwner();
    if(this.running)throw new Error('Pause capture before restoring an archive');
    const result=await this.exclusiveStorageTask(()=>runStorageTask<{addedEvents:number;addedNotes:number;addedDecisions:number}>({op:'import',database:join(this.output,'events.sqlite'),output:this.output,id}));
    this.usageReader.rebindPricing();
    this.surfaceHistory=this.store.settingsEvents().sort((a,b)=>a.observedAt-b.observedAt);
    this.invalidateSummaries();
    return result;
  }
  private async exclusiveStorageTask<T>(run:()=>Promise<T>):Promise<T>{
    if(this.storageTask)throw new Error('Another storage operation is still running');
    const task=run();this.storageTask=task;
    try{return await task;}finally{this.storageTask=undefined;}
  }
  storageUsage(){return {...storageUsage(this.output),storageLimitMB:this.surfaces.storageLimitMB,care:{...this.careState,paused:existsSync(join(this.output,'storage-paused.json'))}};}
  reclaimWal(){this.requireOwner();if(this.storageTask)throw new Error('Wait for the storage operation to finish before reclaiming space');this.store.checkpointWal();return this.storageUsage();}
  /** The verified copy and VACUUM run in a worker thread; this resolves when the copy is ready. */
  prepareStorageCompaction(){
    if(this.running||this.stopping)throw new Error('Pause capture before preparing storage recovery');
    this.requireOwner();
    return this.exclusiveStorageTask(()=>prepareCompactionAsync(this.output,this.summaryOptions(),()=>this.store.revision(),(source,target)=>runStorageTask({op:'optimize',source,target})));
  }
  prepareStorageRestore(id:string){
    if(this.running||this.stopping)throw new Error('Pause capture before replacing storage');
    if(this.storageTask)throw new Error('Another storage operation is still running');
    this.requireOwner();return this.exclusiveStorageTask(()=>runStorageTask({op:'restore',database:join(this.output,'events.sqlite'),output:this.output,id}));
  }
  cancelStorageReplacement(){this.requireOwner();return cancelPendingReplacement(this.output);}
  storageReplacementStatus(){const pending=pendingReplacement(this.output);return pending?{candidate:pending.candidate,backup:pending.backup,kind:pending.kind}:null;}
  storageReplacementResult(){return replacementResult(this.output);}
  verifyHooks(){return this.afterHookChange(this.hookInstallation.verify());}
  privacyExclusions(){return this.privacy.list();}
  setPrivacyExclusions(entries:PrivacyExclusion[]){
    if(!this.lockOwned&&existsSync(join(this.output,'capture.lock')))throw new Error('Change privacy exclusions in the app that owns capture');
    return this.privacy.replace(entries);
  }
  async installHooks(provider:HookProvider,targetIds?:string[]){
    try{return await this.hookInstallation.install(provider,targetIds);}finally{this.hookStatusCache=undefined;}
  }
  dismissHookSetup(){return this.afterHookChange(this.hookInstallation.dismiss());}
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
  /**
   * Workspaces seen in recent agent evidence. Cached for minutes and read from
   * indexed rows, so website resolution never replays the history.
   */
  private knownWorkspaces():KnownWorkspace[]{
    if(this.knownWorkspaceCache&&Date.now()-this.knownWorkspaceCache.at<knownWorkspacesTtlMs)return this.withFocusedWorkspaces(this.knownWorkspaceCache.value);
    const known=new Map<string,KnownWorkspace>();
    for(const row of this.store.workspaceObservations(Date.now()/1000-90*86400)){
      const workspaceId=row.workspaceId,path=row.cwd||workspaceId?.split('::').at(-1);
      if(workspaceId&&path&&isAbsolute(path))known.set(workspaceId,{workspaceId,workspacePath:resolve(path),projectPath:projectPathFromWorktree(path)});
    }
    this.knownWorkspaceCache={at:Date.now(),value:[...known.values()]};
    return this.withFocusedWorkspaces(this.knownWorkspaceCache.value);
  }
  private withFocusedWorkspaces(base:KnownWorkspace[]):KnownWorkspace[]{
    if(!this.focusedTabs.length)return base;
    const known=new Map(base.map(item=>[item.workspaceId,item]));
    for(const tab of this.focusedTabs){const path=tab.workspaceId.split('::').at(-1);if(path&&isAbsolute(path))known.set(tab.workspaceId,{workspaceId:tab.workspaceId,workspacePath:resolve(path),projectPath:projectPathFromWorktree(path)});}
    return [...known.values()];
  }
  websiteProjects(){
    const paths=[...new Set([...this.websiteResolver.candidateProjects(this.knownWorkspaces()),...[...this.websiteMatches.values()].map(match=>match.projectPath).filter((path):path is string=>Boolean(path))])].sort();
    return {rules:this.websiteResolver.rules(),projects:paths,matches:[...this.websiteMatches.values()].sort((a,b)=>b.observedAt-a.observedAt).slice(0,30)};
  }
  previewWebsiteRule(pattern:string,projectPath:string){
    if(!isAbsolute(projectPath))throw new Error('Choose an absolute project directory');
    // The preview covers the last seven days.
    const today=localDate(Date.now()/1000);
    return previewWebsiteRuleImpact(pattern,projectPathFromWorktree(projectPath),this.rangeSummary(addDays(today,-7),8).intervals,this.websiteResolver.rules());
  }
  setWebsiteRule(pattern:string,projectPath:string){
    if(!this.lockOwned&&existsSync(join(this.output,'capture.lock')))throw new Error('Change website rules in the app that owns capture');
    this.websiteResolver.setRule(pattern,projectPath);this.websiteRevision++;this.websiteMatches.clear();this.websiteApplied.clear();return this.websiteProjects();
  }
  removeWebsiteRule(pattern:string){
    if(!this.lockOwned&&existsSync(join(this.output,'capture.lock')))throw new Error('Change website rules in the app that owns capture');
    this.websiteResolver.removeRule(pattern);this.websiteRevision++;this.websiteMatches.clear();this.websiteApplied.clear();return this.websiteProjects();
  }
  /**
   * Local dates whose summaries contain the given activity pairs. Pairs name
   * Mac activity samples, so their stored times locate the days to load.
   */
  private datesForPairs(pairs:Array<[string,string]>):string[]{
    const times=this.store.eventTimes(pairs.flat());
    return [...new Set(pairs.flatMap(pair=>pair.map(id=>times.get(id))).filter((at):at is number=>at!==undefined).map(at=>localDate(at)))].sort();
  }
  /** The day a review result belongs to: the caller's date, or the day most of the pairs start on. */
  private reviewDate(pairs:Array<[string,string]>,date?:string):string{
    if(date!==undefined)return date;
    const times=this.store.eventTimes(pairs.map(pair=>pair[0])),counts=new Map<string,number>();
    for(const [start] of pairs){const at=times.get(start);if(at!==undefined){const day=localDate(at);counts.set(day,(counts.get(day)||0)+1);}}
    return [...counts].sort((a,b)=>b[1]-a[1]||b[0].localeCompare(a[0]))[0]?.[0]||localDate(Date.now()/1000);
  }
  private humanIntervals(dates:string[]){return dates.flatMap(date=>this.windowSummary(date).intervals.filter(i=>i.state==='human'));}
  /**
   * Returns the summary for `date` (YYYY-MM-DD, local) when given; otherwise for
   * the day the selected activity belongs to. Never the whole history.
   */
  setHumanDecision(pairs:Array<[string,string]>,mode:'assigned'|'unassigned'|'clear',projectPath?:string,date?:string):Summary {
    if(!this.lockOwned&&existsSync(join(this.output,'capture.lock')))throw new Error('Review activity in the app that owns capture');
    if(!Array.isArray(pairs)||!pairs.length||pairs.length>MAX_DECISION_PAIRS||!['assigned','unassigned','clear'].includes(mode))throw new Error('Invalid activity selection');
    if(date!==undefined)localDayBounds(date);
    if(pairs.some(pair=>!Array.isArray(pair)||pair.length!==2||pair.some(id=>typeof id!=='string'||!id||id.length>128)))throw new Error('Activity changed; refresh and try again');
    const keys=new Set(this.humanIntervals(this.datesForPairs(pairs)).map(humanIntervalKey).filter(Boolean));
    if(pairs.some(pair=>!keys.has(`${pair[0]}:${pair[1]}`)))throw new Error('Activity changed; refresh and try again');
    let path:string|null=null;
    if(mode==='assigned'){
      if(typeof projectPath!=='string'||!isAbsolute(projectPath))throw new Error('Choose an absolute project directory');
      path=projectPathFromWorktree(projectPath);
      if(!existsSync(path)||!statSync(path).isDirectory())throw new Error('Choose an existing project directory');
    }
    this.store.setHumanDecisions([...new Map(pairs.map(pair=>[pair.join(':'),pair])).values()],mode,path);
    this.summaryCache=undefined;
    return this.daySummary(this.reviewDate(pairs,date));
  }
  reviewHistory(){return this.store.reviewActions();}
  /**
   * Review snapshot for a past day, from the persistent cache when nothing it
   * depends on changed. Days whose window still reaches the present are rebuilt.
   */
  private pastDayReviewSnapshot(date:string){
    const {from,to}=localDayBounds(date),bounds=windowBounds(from,to,this.summaryOptions().agentIdleThreshold);
    if(bounds.readTo>Date.now()/1000)return this.dayReviewSnapshot(date);
    const saved=this.store.dayReview(date);
    // Reviews saved before fingerprints were versioned need the one-time check.
    if(saved&&!saved.fingerprint.startsWith(FINGERPRINT_VERSION))return this.dayReviewSnapshot(date);
    const {humanIdleMinutes,agentIdleMinutes,countTaskCounters}=this.surfaces;
    const signature=[DAY_REVIEW_CACHE_VERSION,humanIdleMinutes,agentIdleMinutes,countTaskCounters,this.store.daySignature(bounds.readFrom,bounds.readTo,date)].join('|');
    type Snapshot=ReturnType<Collector['dayReviewSnapshot']>;
    const cached=this.store.cachedDayReview(date,signature) as Snapshot|undefined;
    if(cached)return {...cached,completedAt:saved?.completedAt||null,stale:Boolean(saved&&saved.fingerprint!==cached.fingerprint)};
    const snapshot=this.dayReviewSnapshot(date);
    if(this.lockOwned||!existsSync(join(this.output,'capture.lock')))this.store.cacheDayReview(date,signature,snapshot);
    return snapshot;
  }
  private dayReviewSnapshot(date:string){
    const day=this.daySummary(date),groups=groupHumanReview(day.intervals),pending=groups.filter(group=>['unmatched','conflict'].includes(humanReviewState(group))),captured=groups.filter(group=>humanReviewState(group)==='captured'),unmatched=pending.filter(group=>humanReviewState(group)==='unmatched'),conflicts=pending.filter(group=>humanReviewState(group)==='conflict'),gaps=unobservedGaps(day.intervals);
    const notes=this.store.manualNotes(date);
    // The fingerprint ignores interval order: a bounded day window can list the
    // same intervals in another order than a replay of the whole history did.
    const fingerprint=FINGERPRINT_VERSION+reviewFingerprint(sortedByJson(day.intervals),sortedByJson(reviewIssues(day)),notes);
    const saved=this.store.dayReview(date);
    let stale=Boolean(saved&&saved.fingerprint!==fingerprint);
    if(stale&&saved&&!saved.fingerprint.startsWith(FINGERPRINT_VERSION)&&!this.legacyFingerprintChecked.has(date)){
      // Reviews saved by earlier versions hashed the whole-history order. Check
      // that form once, and store the order-independent fingerprint if it matches.
      this.legacyFingerprintChecked.add(date);
      let legacy=saved.fingerprint===reviewFingerprint(day.intervals,reviewIssues(day),notes);
      if(!legacy){const full=summaryForDate(this.legacyFullSummary(),date);legacy=saved.fingerprint===reviewFingerprint(full.intervals,reviewIssues(full),notes);}
      if(this.lockOwned||!existsSync(join(this.output,'capture.lock')))this.store.updateDayReviewFingerprint(date,legacy?fingerprint:LEGACY_STALE_FINGERPRINT);
      if(legacy)stale=false;
    }
    return {date,completedAt:saved?.completedAt||null,stale,hasActivity:day.intervals.length>0,pendingGroups:pending.length,capturedGroups:captured.length,unmatchedSeconds:unmatched.reduce((total,group)=>total+group.seconds,0),conflicts:conflicts.length,gaps:gaps.length,fingerprint};
  }
  dayReviewStatus(date:string){
    localDayBounds(date);
    const current=this.dayReviewSnapshot(date),backlog=[];
    for(let days=1;days<=7;days++){const key=addDays(date,-days);const item=this.pastDayReviewSnapshot(key);if(item.hasActivity&&(!item.completedAt||item.stale))backlog.push({date:key,unmatchedSeconds:item.unmatchedSeconds,conflicts:item.conflicts,gaps:item.gaps});}
    const {fingerprint:_,...view}=current;return {...view,backlog};
  }
  markDayReview(date:string){
    if(!this.lockOwned&&existsSync(join(this.output,'capture.lock')))throw new Error('Review activity in the app that owns capture');
    const snapshot=this.dayReviewSnapshot(date);if(!snapshot.hasActivity)throw new Error('There is no captured activity to review for this day');
    if(snapshot.pendingGroups)throw new Error(`Review ${snapshot.pendingGroups} remaining activity groups before marking this day reviewed`);
    this.store.markDayReview(date,snapshot.fingerprint);return this.dayReviewStatus(date);
  }
  /** Returns the summary for `date` when given; otherwise for the day the undone activity belongs to. */
  undoReviewAction(id:string,date?:string):Summary{
    if(!this.lockOwned&&existsSync(join(this.output,'capture.lock')))throw new Error('Review activity in the app that owns capture');
    if(date!==undefined)localDayBounds(date);
    const ids=this.store.reviewActionEventIds(id),pairs:Array<[string,string]>=[];
    for(let index=0;index+1<ids.length;index+=2)pairs.push([ids[index]!,ids[index+1]!]);
    this.store.undoReviewAction(id);this.summaryCache=undefined;
    return this.daySummary(this.reviewDate(pairs,date));
  }
  /** Returns the summary for `date` when given; otherwise for the day the split activity belongs to. */
  setHumanGroupSplit(pairs:Array<[string,string]>,splitAt:number,beforeProject?:string,afterProject?:string,date?:string):Summary{
    if(!this.lockOwned&&existsSync(join(this.output,'capture.lock')))throw new Error('Review activity in the app that owns capture');
    if(!Array.isArray(pairs)||!pairs.length||pairs.length>500||!Number.isFinite(splitAt))throw new Error('Invalid activity split');
    if(pairs.some(pair=>!Array.isArray(pair)||pair.length!==2||pair.some(id=>typeof id!=='string'||!id||id.length>128)))throw new Error('Invalid activity split');
    if(date!==undefined)localDayBounds(date);
    const unique=[...new Map(pairs.map(pair=>[pair.join(':'),pair])).values()];
    const ranges=new Map<string,[number,number]>();
    for(const interval of this.humanIntervals(this.datesForPairs(unique))){
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
    this.store.setHumanGroupSplit(unique,splitAt,valid,before,after);this.summaryCache=undefined;
    return this.daySummary(this.reviewDate(unique,date));
  }
  private resolveWebsite(url:string){
    const key=websiteKey(url,this.websiteResolver.rules());if(!key||this.websitePending.has(key))return;
    const revision=this.websiteRevision,known=this.knownWorkspaces(),recent=this.lastOrcaAccessibility?.selectedWorktreeId?{workspaceId:this.lastOrcaAccessibility.selectedWorktreeId,observedAt:this.lastOrcaAccessibility.observedAt}:undefined;
    const pending=this.websiteResolver.resolve(url,known,recent).then(result=>{if(result&&this.running&&revision===this.websiteRevision){if(this.websiteMatches.get(key)?.projectPath!==result.projectPath)this.websiteApplied.delete(key);this.websiteMatches.set(key,result);if(this.websiteMatches.size>200){const oldest=[...this.websiteMatches].sort((a,b)=>a[1].observedAt-b[1].observedAt).slice(0,this.websiteMatches.size-200);for(const [oldKey] of oldest){this.websiteMatches.delete(oldKey);this.websiteApplied.delete(oldKey);}}}}).catch(()=>{/* Keep unverified website activity unassigned. */}).finally(()=>{if(this.websitePending.get(key)===pending)this.websitePending.delete(key);});
    this.websitePending.set(key,pending);
  }
  private invalidateSummaries(){this.summaryCache=undefined;this.days.invalidate();this.decorated.clear();this.reviewCache=undefined;this.knownWorkspaceCache=undefined;}
  updateSettings(patch:Partial<CaptureSettings>){
    validateSettings(patch);
    if(this.stopping)throw new Error('Capture is stopping');
    if(!this.lockOwned&&existsSync(join(this.output,'capture.lock')))throw new Error('Change settings in the app that owns capture');
    const next={...this.surfaces,...patch} as CaptureSettings;
    if(Object.keys(defaultSettings).every(k=>next[k as keyof CaptureSettings]===this.surfaces[k as keyof CaptureSettings]))return this.status();
    const timingChanged=Object.keys(defaultSettings).some(key=>key!=='storageLimitMB'&&next[key]!==this.surfaces[key]);
    const browserChanged=browsers.some(source=>next[source.setting]!==this.surfaces[source.setting]);
    if(this.lockOwned&&timingChanged)this.drainHooks();
    const path=join(this.output,'settings.json');let existing:Record<string,unknown>={};
    try{if(existsSync(path))existing=JSON.parse(readFileSync(path,'utf8'));}catch{/* Rewrite a damaged file from the current settings. */}
    writeFileSync(path+'.tmp',JSON.stringify({...existing,...next},null,2)+'\n',{mode:0o600});renameSync(path+'.tmp',path);
    if(!timingChanged){this.surfaces=next;this.nextStorageCheck=0;return this.status();}
    const change=makeEvent('capture','capture_settings',{data:{previous:{...this.surfaces},surfaces:next}});
    this.store.put(change);this.surfaceHistory.push(change);this.surfaces=next;this.revision++;this.invalidateSummaries();
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
    const accept=(event:CaptureEvent)=>event.source==='agent_report'?validAgentReport(event):this.acceptHook(event);
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
        const age=match?Date.now()/1000-match.observedAt:Infinity;
        if(match&&age<websiteMatchFreshSeconds&&match.projectPath){event.workspaceId=match.workspaceId;event.data={...event.data,websiteAttribution:{source:match.source,projectPath:match.projectPath,detail:match.detail}};if(key){this.websiteApplied.set(key,event.observedAt);if(this.websiteApplied.size>200)this.websiteApplied.delete(this.websiteApplied.keys().next().value!);}}
        // The resolver caches per website for minutes; local pages only recheck their port owner.
        if(!match||age>=websiteRecheckSeconds)this.resolveWebsite(browserUrl);
      }
      if(payload.foregroundBundleId==='com.stablyai.orca'&&typeof payload.orcaSelectedTabTitle==='string'&&!resolveOrcaTab(payload.orcaSelectedTabTitle,this.focusedTabs))this.refreshFocusedTabs(focusMissRefreshMs);
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
  /**
   * Coverage for a problem seen on every poll (Orca closed, a failing read) is
   * stored when it starts, not on every tick. It is stored again when it recurs
   * after clearing, at most once per `coverageRepeatMs`.
   */
  private noteCoverage(source:string,reason:string){
    const key=`${source}\u0000${reason}`;this.coverageSeen.add(key);
    if(this.coverageActive.has(key))return;
    this.coverageActive.add(key);
    const last=this.coverageRecordedAt.get(key);
    if(last!==undefined&&Date.now()-last<coverageRepeatMs)return;
    this.coverageRecordedAt.set(key,Date.now());
    if(this.coverageRecordedAt.size>500)this.coverageRecordedAt.delete(this.coverageRecordedAt.keys().next().value!);
    try{this.store.put(makeEvent(source,'coverage',{data:{reason}}));}
    catch(error){this.lastError=`Could not save ${source} coverage: ${String(error)}`;}
  }
  private endCoverageTick(){this.coverageActive=this.coverageSeen;this.coverageSeen=new Set();}
  private refreshProbeTrust():Promise<void>|undefined{return this.activityProbe.refreshTrust(this.macos);}
  /** Raw window summary for a local day, with review decisions applied (not clipped to the day). */
  private windowSummary(date:string,maxAgeMs=0):Summary{
    const window=this.days.window(date,maxAgeMs),review=this.reviewData(),key=`${window.version}:${review.revision}`;
    const cached=this.decorated.get(date);
    if(cached?.key===key)return cached.value;
    const value=applyHumanDecisions(window.raw,review.decisions,review.splits);
    this.decorated.set(date,{key,value});
    while(this.decorated.size>1&&(this.decorated.size>16||[...this.decorated.values()].reduce((n,entry)=>n+estimatedBytes(entry.value,8*1024*1024),0)>8*1024*1024))this.decorated.delete(this.decorated.keys().next().value!);
    return value;
  }
  private reviewData(){
    // Review edits by this process bump the store's revision; edits by another
    // process change PRAGMA data_version. Both are cheap to check.
    const revision=this.store.incrementalSafetyRevision();
    if(this.reviewCache?.revision!==revision)this.reviewCache={revision,decisions:this.store.humanDecisions(),splits:this.store.humanSplits()};
    return this.reviewCache;
  }
  private daySummary(date:string,maxAgeMs=0):Summary{
    const window=this.windowSummary(date,maxAgeMs),cached=this.decorated.get(date);
    const day=cached?.value!==window?summaryForDate(window,date):cached.day||=summaryForDate(window,date);
    const resources=this.resources(),reports=this.surfaces.countTaskCounters?this.reportedWork(date):[],counters=JSON.stringify(reports);
    // Same inputs return the same object, so its version token stays stable.
    const memo=this.derivedMemo;
    if(memo&&memo.day===day&&memo.resources===resources&&memo.counters===counters)return memo.value;
    const resourced=applyReportedResources(day,resources);
    // Counters are opt-in credit and stay open while running, so they are applied per read.
    const value=reports.length?creditTaskCounters(resourced,reports):resourced;
    this.derivedMemo={day,resources,counters,value};
    return value;
  }
  /** Pages agents reported in the last 31 days, refreshed at most every 10 seconds. */
  private resources(){
    if(!this.resourceCache||Date.now()-this.resourceCache.at>10_000){
      const now=Date.now()/1000;
      const next=reportedResources(this.store.agentReports(now-31*86400,now+60)),previous=this.resourceCache?.value;
      // Keep the previous map when nothing changed, so derived summaries keep their identity.
      const same=previous&&previous.size===next.size&&[...next].every(([key,value])=>previous.get(key)?.observedAt===value.observedAt);
      this.resourceCache={at:Date.now(),value:same?previous:next};
    }
    return this.resourceCache.value;
  }
  /** Day summaries for `count` days from `startDate`, joined into one summary. */
  private rangeSummary(startDate:string,count:number,maxAgeMs=0):Summary{
    const days=Array.from({length:count},(_,offset)=>this.daySummary(addDays(startDate,offset),maxAgeMs));
    const sessions=new Map<string,Summary['sessions'][number]>();
    for(const day of days)for(const session of day.sessions)sessions.set(session.key,session);
    const sum=(key:'humanSeconds'|'agentSeconds'|'elapsedSeconds'|'childAgentSeconds'|'mainAgentSeconds'|'agentWallSeconds')=>days.reduce((total,day)=>total+(day[key]||0),0);
    return {intervals:days.flatMap(day=>day.intervals),unresolved:days.flatMap(day=>day.unresolved),coverage:days.flatMap(day=>day.coverage),sessions:[...sessions.values()],
      humanSeconds:sum('humanSeconds'),agentSeconds:sum('agentSeconds'),elapsedSeconds:sum('elapsedSeconds'),childAgentSeconds:sum('childAgentSeconds'),mainAgentSeconds:sum('mainAgentSeconds'),agentWallSeconds:sum('agentWallSeconds'),
      issueReasons:[...new Set(days.flatMap(day=>day.issueReasons||[]))]};
  }
  /**
   * The whole-history summary. Only the `summary` request without a date and
   * reports use it; everything the app polls reads bounded day summaries.
   */
  summary(maxAgeMs=0):Summary {
    const revision=this.store.revision();
    if(this.summaryCache&&(this.summaryCache.revision===revision||maxAgeMs>0&&Date.now()-this.summaryCache.at<maxAgeMs))return this.summaryCache.value;
    const events=this.store.events();
    const summary=applyHumanDecisions(summarize(events,{...this.summaryOptions(),alreadyUnique:true}),this.store.humanDecisions(),this.store.humanSplits());
    applyTerminalTitles(summary,events);
    this.summaryCache=estimatedBytes(summary)<=32*1024*1024?{revision,at:Date.now(),value:summary}:undefined;return summary;
  }
  /**
   * Whole-history summary for the one-time legacy fingerprint check. It is kept
   * only briefly so checking several days at startup shares one replay, then
   * released: holding the full history keeps hundreds of MB resident.
   */
  private legacyFullSummary():Summary{
    const value=this.summary();
    clearTimeout(this.legacySummaryRelease);
    this.legacySummaryRelease=setTimeout(()=>{this.summaryCache=undefined;},30_000);
    this.legacySummaryRelease.unref?.();
    return value;
  }
  /**
   * Day summary with a version token. When `since` matches the token of the
   * summary the caller already has, only `{unchanged:true,token}` is returned,
   * so polls do not resend megabytes of unchanged intervals.
   */
  summaryForDate(date:string,maxAgeMs=0):Summary{return this.daySummary(date,maxAgeMs);}
  versionedSummary(date:string,maxAgeMs=0,since?:string):Summary&{token:string}|{unchanged:true;token:string}{
    const summary=this.daySummary(date,maxAgeMs);
    let token=this.summaryTokens.get(summary);
    if(!token){token=`${this.summaryEpoch}-${++this.summaryTokenCount}`;this.summaryTokens.set(summary,token);}
    return since===token?{unchanged:true,token}:{...summary,token};
  }
  reportedWork(date:string){
    const first=new Date(`${date}T00:00:00`),last=new Date(first);
    last.setDate(last.getDate()+1);
    const start=first.getTime()/1000,end=last.getTime()/1000;
    const now=Date.now()/1000;
    return reportedWorkForDay(this.store.agentReports(start-86400,end),start,end,now,this.store.sessionEnds(start-86400,Math.max(end,now)+60));
  }
  /**
   * Stop an agent-reported timer from the app, for timers an agent left open.
   * `discard` removes it from the timeline and from counted time.
   */
  stopReportedTimer(taskCounterId:string,discard=false){
    if(!this.lockOwned&&existsSync(join(this.output,'capture.lock')))throw new Error('Stop timers in the app that owns capture');
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskCounterId))throw new Error('Invalid timer');
    const now=Date.now()/1000,start=this.store.agentReports(now-31*86400,now+60).find(event=>event.kind==='task_start'&&event.eventId===taskCounterId);
    if(!start)throw new Error('This timer no longer exists');
    this.store.put(makeEvent('agent_report','task_stop',{provider:start.provider,sessionId:start.sessionId,workspaceId:start.workspaceId,data:{taskCounterId,stoppedBy:'user',...(discard?{discarded:true}:{})}}));
    this.summaryCache=undefined;
    return {stopped:taskCounterId,discarded:discard};
  }
  weeklyReview(startDate:string){
    try{localDayBounds(startDate);}catch{throw new Error('Invalid week start');}
    const accepted=new Set<string>();
    // Consume and review each day while its window is still cached. Retaining
    // all seven days and then revisiting evicted windows doubled large reads.
    return weeklyReview(date=>{
      const day=this.daySummary(date,15000),snapshot=this.dayReviewSnapshot(date);
      if(snapshot.completedAt&&!snapshot.stale&&!snapshot.pendingGroups)accepted.add(date);
      return day;
    },startDate,accepted);
  }
  workOutcomes(date:string){localDayBounds(date);return localWorkOutcomes(this.windowSummary(date,15000),date);}
  manualNotes(date:string){return this.store.manualNotes(date);}
  addManualNote(input:Omit<ManualNote,'id'|'createdAt'>){this.requireOwner();return this.store.addManualNote(input);}
  removeManualNote(id:string){this.requireOwner();return this.store.removeManualNote(id);}
  private requireOwner(){if(!this.lockOwned&&existsSync(join(this.output,'capture.lock')))throw new Error('Edit manual notes in the app that owns capture');}
  async start(durationSeconds?:number) {
    if(durationSeconds!==undefined&&(!Number.isFinite(durationSeconds)||durationSeconds<1||durationSeconds>86400))throw new Error('Duration must be 1–86400 seconds');
    if(this.running)return this.status();
    if(this.starting)throw new Error('Capture is already starting');
    if(this.stopping)throw new Error('Capture is stopping');
    if(this.storageTask)throw new Error('Wait for the storage operation to finish before resuming capture');
    const lock=join(this.output,'capture.lock');
    clearStaleLock(lock,{unreadable:'Unreadable collector lock; inspect before removing',live:'Another collector owns this data directory'});
    writeLock(lock);this.lockOwned=true;this.starting=true;const epoch=++this.startEpoch;this.lastError=null;this.failedPoller=null;this.macError=null;
    try{
      if(!await this.ensureStorageCapacity())throw new Error(this.lastError!);
      if(!this.lockOwned||this.startEpoch!==epoch)throw new Error('Capture start was cancelled');
      this.running=true;
      this.nextStorageCheck=Date.now()+10000;this.scheduleStorageCare(30000);
      this.store.put(makeEvent('capture','capture_start'));
      this.activityProbe.start();
      // After an app update, install the new hook runtime without asking. Only
      // the packaged app does this: the runtime copies the running Node binary.
      if(process.execPath.includes('.app/Contents/MacOS/'))setTimeout(()=>{
        try{if(this.running&&this.hookInstallation.refreshRuntime())this.hookStatusCache=undefined;}catch(error){this.lastError=`Hook runtime refresh failed: ${String(error)}`;}
      },3000).unref();
      this.syncUsage();
      if(durationSeconds!==undefined)this.deadline=setTimeout(()=>{void this.stop();},durationSeconds*1000);
      await this.tick();return this.status();
    }catch(error){
      this.running=false;this.activityProbe.stop();clearTimeout(this.careTimer);clearTimeout(this.deadline);
      if(ownsLock(lock))unlinkSync(lock);
      this.lockOwned=false;throw error;
    }finally{this.starting=false;}
  }
  private async tick() {
    if(!this.running||this.checkingStorage)return;
    if(Date.now()>=this.nextStorageCheck){this.nextStorageCheck=Date.now()+10000;this.checkingStorage=true;try{if(!await this.ensureStorageCapacity()){this.store.put(makeEvent('capture','coverage',{data:{reason:this.lastError}}));await this.stop();return;}}finally{this.checkingStorage=false;}}
    if(!this.running)return;
    this.inFlight=this.poll().catch(error=>{this.lastError=`Capture poll failed: ${String(error)}`;});
    await this.inFlight;this.inFlight=undefined;
    if(this.running)this.timer=setTimeout(()=>{void this.tick();},this.interval*1000);
  }
  /**
   * One Orca terminal list per tick serves both the terminal observations and
   * the focused-tab index; the layouts are included for the latter.
   */
  private readTerminals():Promise<unknown>{
    if(this.terminalReceipt&&Date.now()-this.terminalReceipt.at<1000)return this.terminalReceipt.promise;
    const promise=this.reader(['terminal','list','--include-visual-layouts','--limit','1000','--json']);
    const entry={at:Date.now(),promise};this.terminalReceipt=entry;
    promise.then(receipt=>{
      if(this.running&&this.surfaces.macosActivity){this.focusedTabs=tabIndexFromTerminalList(receipt);this.focusedTabsAt=Date.now();}
    },()=>{if(this.terminalReceipt===entry)this.terminalReceipt=undefined;});
    return promise;
  }
  private refreshFocusedTabs(minimumAgeMs=focusRefreshMs){
    if(this.focusRefresh||!this.running||!this.surfaces.macosActivity)return;
    if(Date.now()-Math.max(this.focusedTabsAt,this.focusRequestedAt)<minimumAgeMs||!this.orcaAvailable())return;
    this.focusRequestedAt=Date.now();
    this.focusRefresh=(async()=>{
      try{await this.readTerminals();}
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
        const memory=this.pollerMemory.get(source.id)||{};this.pollerMemory.set(source.id,memory);
        const error=await source.poll({reader:this.reader,runId:this.runId,valid,store:this.store,memory,terminals:()=>this.readTerminals(),coverage:reason=>this.noteCoverage(source.id,reason)});
        if(valid()&&error&&!pollingError){pollingError=error;failedPoller=source.id;}
      }
      const claimed=[join(this.output,'spool'),...this.legacyHookSpools].filter(claimSpoolOverflow);
      const spoolIssues=this.drainHooks(),currentIssues=new Set(spoolIssues.map(issue=>issue.reason));
      for(const issue of spoolIssues)if(!this.seenSpoolIssues.has(issue.reason)||issue.reason===spoolOverflowReason&&claimed.length>0)this.store.put(makeEvent('hook','coverage',{data:{reason:issue.reason}}));
      this.seenSpoolIssues=currentIssues;for(const folder of claimed)acknowledgeSpoolOverflow(folder);
      this.lastPoll=Date.now()/1000;this.lastError=pollingError;this.failedPoller=failedPoller;
    }catch(error){this.lastError=String(error);this.failedPoller=null;this.noteCoverage('capture',this.lastError);}
    finally{this.endCoverageTick();}
  }
  stop():Promise<ReturnType<Collector['status']>> {
    if(this.stopping)return this.stopping;
    if(!this.lockOwned)return Promise.resolve(this.status());
    this.stopping=this.stopOwned().finally(()=>{this.stopping=undefined;});return this.stopping;
  }
  private async stopOwned() {
    this.startEpoch++;
    this.running=false;clearTimeout(this.careTimer);clearTimeout(this.timer);clearTimeout(this.deadline);
    this.focusedTabs=[];this.focusedTabsAt=0;
    // Kill the helper immediately; slow fleet reads cannot orphan it during shutdown.
    this.activityProbe.stop();
    await this.usageReader.stop();
    await this.inFlight;
    try{this.drainHooks();this.store.put(makeEvent('capture','capture_stop'));}
    catch(error){this.lastError=`Could not finish capture cleanly: ${String(error)}`;}
    finally{if(this.lockOwned){const lock=join(this.output,'capture.lock');if(ownsLock(lock))unlinkSync(lock);this.lockOwned=false;}}
    return this.status();
  }
  async close(){this.linear.close();await this.stop();await this.storageTask?.catch(()=>{});await this.usageReader.close();this.store.close();}
}
