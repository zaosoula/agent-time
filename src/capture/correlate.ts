import type { CaptureEvent, Interval, Issue, Session, Summary } from './events.ts';
import {eventWorkMetadata,type WorkMetadata} from './work-context.ts';
import {agentSessionKey,hasNativeSessionIdentity} from './session-identity.ts';
import { workerSnapshotValidSeconds } from './observation-retention.ts';
export function unionSeconds(intervals:Array<[number,number]>):number {
 const merged:Array<[number,number]>=[];
 for(const [start,end] of [...intervals].sort((a,b)=>a[0]-b[0])) {
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<start)throw new Error('invalid interval');
  const last=merged.at(-1);if(last&&start<=last[1])last[1]=Math.max(last[1],end);else merged.push([start,end]);
 }
 return merged.reduce((sum,[start,end])=>sum+end-start,0);
}
// Credit one minute per distinct activity block. Callers group eligible agent
// gaps first; this function only merges actual overlaps before rounding.
export function minuteCreditSeconds(intervals:Array<[number,number]>):number {
 return groupIntervals(intervals,0).reduce((sum,[start,end])=>sum+Math.ceil((end-start)/60)*60,0);
}
/**
 * Blockers that may stop two activity ranges from merging. A blocker (from,to)
 * separates `previousEnd` and `nextStart` when from<nextStart and to>previousEnd.
 * Sorting by `from` with a running maximum of `to` answers that in O(log n).
 */
export class BlockerIndex {
 private starts:number[];private maxEnds:number[];
 constructor(blockers:Array<[number,number]>){
  const sorted=[...blockers].sort((a,b)=>a[0]-b[0]);
  this.starts=sorted.map(([from])=>from);this.maxEnds=[];
  let max=-Infinity;for(const [,to] of sorted){max=Math.max(max,to);this.maxEnds.push(max);}
 }
 separates(previousEnd:number,nextStart:number):boolean{
  let low=0,high=this.starts.length;
  while(low<high){const mid=(low+high)>>>1;if(this.starts[mid]!<nextStart)low=mid+1;else high=mid;}
  return low>0&&this.maxEnds[low-1]!>previousEnd;
 }
}
export function groupIntervals(intervals:Array<[number,number]>,maxGap=60,blockers:Array<[number,number]>|BlockerIndex|BlockerIndex[]=[]):Array<[number,number]> {
 if(!Number.isFinite(maxGap)||maxGap<0)throw new Error('invalid grouping gap');
 const indexes=Array.isArray(blockers)?blockers.length&&blockers[0] instanceof BlockerIndex?blockers as BlockerIndex[]:[new BlockerIndex(blockers as Array<[number,number]>)]:[blockers];
 const grouped:Array<[number,number]>=[];
 for(const [start,end] of [...intervals].sort((a,b)=>a[0]-b[0])){
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<start)throw new Error('invalid interval');
  const last=grouped.at(-1);
  if(last&&start-last[1]<=maxGap&&!indexes.some(index=>index.separates(last[1],start)))last[1]=Math.max(last[1],end);
  else grouped.push([start,end]);
 }
 return grouped;
}
const settled=(e:CaptureEvent)=>['succeeded','failed','completed','cancelled','abandoned'].includes(String(e.data?.outcome));
/** A total order for equal normalized wall times. Comparing monotonic time only
 * within an epoch and event IDs across epochs formed comparator cycles, making
 * the result depend on unrelated rows removed by compaction. Shared with its
 * lightweight global-order verifier. */
export function compareCausalPosition(aEpoch:string,aMonotonic:number,bEpoch:string,bMonotonic:number):number{
 return aEpoch.localeCompare(bEpoch)||aMonotonic-bMonotonic;
}
export function summarize(input:CaptureEvent[],options:{idleThreshold?:number;agentIdleThreshold?:number;maxGap?:number;alreadyUnique?:boolean}={}):Summary {
 const maxGap=options.maxGap??15,idle=options.idleThreshold??300,agentIdle=options.agentIdleThreshold??300;
 if(!Number.isFinite(idle)||idle<=0||!Number.isFinite(agentIdle)||agentIdle<=0)throw new Error('invalid idle threshold');
 // SQLite's event_id primary key guarantees this for collector reads. Keep
 // the general reducer's last-duplicate-wins behavior for other callers.
 const unique:CaptureEvent[]=options.alreadyUnique?input.slice():[];
 if(!options.alreadyUnique){
  const byId=new Map<string,number>();
  for(const event of input){
   const index=byId.get(event.eventId);
   if(index===undefined){byId.set(event.eventId,unique.length);unique.push(event);}
   else unique[index]=event;
  }
 }
 // Preserve per-epoch causal order even when wall time rolls backwards, with a transitive global ordering.
 const epochGroups=new Map<string,CaptureEvent[]>();
 for(const e of unique){const group=epochGroups.get(e.collectorEpoch)||[];group.push(e);epochGroups.set(e.collectorEpoch,group);}
 const sortTime=new Map<string,number>();
 for(const group of epochGroups.values()){let time=-Infinity;for(const e of group.sort((a,b)=>a.monotonicAt-b.monotonicAt||a.eventId.localeCompare(b.eventId))){time=Math.max(time,e.observedAt);sortTime.set(e.eventId,time);}}
 const events=unique.sort((a,b)=>sortTime.get(a.eventId)!-sortTime.get(b.eventId)!||compareCausalPosition(a.collectorEpoch,a.monotonicAt,b.collectorEpoch,b.monotonicAt)||a.eventId.localeCompare(b.eventId));
 const intervals:Interval[]=[],unresolved:Issue[]=[],coverage:Issue[]=[],sessions=new Map<string,Session>();
 const globalFences:number[]=[],sessionFences=new Map<string,number[]>(),standaloneIntervals=new Map<string,Interval[]>();
 const commonByKey=new Map<string,WorkMetadata>(),eventMetadata=new WeakMap<CaptureEvent,WorkMetadata>(),metadataPool=new Map<string,unknown>();
 function readMetadata(event:CaptureEvent):WorkMetadata{
  const metadata=eventWorkMetadata(event);
  for(const field of ['attributes','agentIdentity'] as const)if(metadata[field]){
   const key=field+JSON.stringify(metadata[field]),previous=metadataPool.get(key);
   if(previous)Object.assign(metadata,{[field]:previous});else if(metadataPool.size<2048)metadataPool.set(key,metadata[field]);
  }
  return metadata;
 }
 const metadataKeys=['agentIdentity','agentProfile','attributes','metadataSource','projectPath','metadataWarning'] as const;
 const metadataOf=(value:WorkMetadata):WorkMetadata=>Object.fromEntries(metadataKeys.filter(key=>value[key]!==undefined).map(key=>[key,value[key]]));
 function rememberMetadata(key:string,value:WorkMetadata){
  const previous=commonByKey.get(key);
  if(!previous){commonByKey.set(key,metadataOf(value));return;}
  for(const field of metadataKeys)if(JSON.stringify(previous[field])!==JSON.stringify(value[field]))delete previous[field];
 }
 const workerPrevious=new Map<string,CaptureEvent>(),childLifecycle=new Map<string,CaptureEvent>();
 const active=new Map<string,{event:CaptureEvent;state:'running'|'waiting';session:Session;key:string}>();
 const provisional:Array<{event:CaptureEvent;session:Session;key:string}>=[];
 /** Background shells by `key:taskId`, open from launch until their completion notice. `seen` is the latest Stop that listed it running. */
 type BackgroundRun={event:CaptureEvent;session:Session;key:string;taskId:string;seen?:CaptureEvent;segmentStart?:number;confirmed?:Array<{start:number;end:CaptureEvent}>;gaps?:CaptureEvent[]};
 const background=new Map<string,BackgroundRun>();
 const turnStarts=new Map<string,CaptureEvent>(),activityAnchors=new Map<string,number[]>();
 const bindings=new Map<string,CaptureEvent>(),toolBindings=new Map<string,CaptureEvent>(),promotedBindings=new Map<string,CaptureEvent>();
 const workerSnapshots=new Map<string,CaptureEvent[]>();let activityPrevious:CaptureEvent|undefined;
 const workerKey=(e:CaptureEvent)=>JSON.stringify([typeof e.hostId,e.hostId,typeof e.terminalHandle,e.terminalHandle]);
 for(const e of events)if(e.kind==='worker'){
  const key=workerKey(e),group=workerSnapshots.get(key)||[];group.push(e);workerSnapshots.set(key,group);
 }
 for(const group of workerSnapshots.values())group.sort((a,b)=>a.observedAt-b.observedAt);
 const identity=(e:CaptureEvent)=>JSON.stringify([e.hostId??null,e.provider??null,e.sessionId??null,e.terminalHandle??null]);
 const nativeIdentity=(e:CaptureEvent)=>agentSessionKey({...e,dispatchId:undefined,child:false});
 const backgroundOwner=(e:CaptureEvent)=>agentSessionKey({...e,dispatchId:undefined,child:Boolean(e.agentId)});
 const toolIdentity=(e:CaptureEvent)=>JSON.stringify([nativeIdentity(e),e.agentId??null,e.data?.toolId??'anonymous']);
 function getSession(key:string,e:CaptureEvent,child=false):Session {
  let s=sessions.get(key);
  // A hook may precede the first worker snapshot. Promote that provider session
  // once a bounded terminal observation supplies its Dispatch identity.
  if(!child&&e.dispatchId&&e.sessionId){
   const standaloneKey=agentSessionKey({...e,dispatchId:undefined,child:false}),standalone=sessions.get(standaloneKey);
   if(standalone){
    if(!s){s=standalone;s.key=key;sessions.set(key,s);}
    s.sessionId=e.sessionId;s.cwd ||= standalone.cwd;s.provider ||= standalone.provider;
    for(const field of metadataKeys)if(s[field]===undefined&&standalone[field]!==undefined)Object.assign(s,{[field]:standalone[field]});
    const oldMetadata=commonByKey.get(standaloneKey);if(oldMetadata){rememberMetadata(key,oldMetadata);commonByKey.delete(standaloneKey);}
    s.runId=e.runId;s.taskId=e.taskId;s.dispatchId=e.dispatchId;s.workspaceId=e.workspaceId||s.workspaceId;s.terminalHandle ||= e.terminalHandle;
    promotedBindings.set(standaloneKey,e);
    s.lastObservedAt=Math.max(s.lastObservedAt,standalone.lastObservedAt);
    const sessionKey=standaloneKey;
    for(const i of standaloneIntervals.get(sessionKey)||[])if(!i.dispatchId){i.dispatchId=e.dispatchId;i.runId=e.runId;i.taskId=e.taskId;i.workspaceId=e.workspaceId;}
    standaloneIntervals.delete(sessionKey);
    for(const [id,a] of [...active])if(a.key===standaloneKey){active.delete(id);a.key=key;a.session=s;active.set(key+id.slice(standaloneKey.length),a);}
    for(const item of provisional)if(item.key===standaloneKey){item.key=key;item.session=s;}
    for(const [id,b] of [...background])if(b.key===standaloneKey){background.delete(id);b.key=key;b.session=s;background.set(key+':'+b.taskId,b);}
    const turn=turnStarts.get(standaloneKey);if(turn){turnStarts.delete(standaloneKey);turnStarts.set(key,turn);}
    const oldFences=sessionFences.get(standaloneKey);if(oldFences){sessionFences.delete(standaloneKey);sessionFences.set(key,[...(sessionFences.get(key)||[]),...oldFences]);}
    const oldAnchors=activityAnchors.get(standaloneKey);if(oldAnchors){activityAnchors.delete(standaloneKey);activityAnchors.set(key,[...(activityAnchors.get(key)||[]),...oldAnchors]);}
    for(const [id,b] of toolBindings)if(!b.dispatchId&&nativeIdentity(b)===standaloneKey)toolBindings.set(id,applyBinding(b,e));
    sessions.delete(standaloneKey);
   }
  }
  if(!s){s={key,hostId:e.hostId,workspaceId:e.workspaceId,cwd:e.cwd,runId:e.runId,taskId:e.taskId,dispatchId:e.dispatchId,sessionId:e.sessionId,agentId:e.agentId,provider:e.provider,terminalHandle:e.terminalHandle,title:String(e.data?.title||`${child?(e.data?.childType||e.provider||'Native'):e.provider||'Agent'} ${child?'subagent':'session'}`),state:'unknown',lastObservedAt:e.observedAt,seconds:0,observedSeconds:0,child,proof:'unresolved'};sessions.set(key,s);}
  Object.assign(s,readMetadata(e));
  // Snapshot preceding context: later hooks may change the session while this tool stays open.
  eventMetadata.set(e,metadataOf(s));
  s.lastObservedAt=Math.max(s.lastObservedAt,e.observedAt);return s;
 }
 function rememberActivity(key:string,time:number){const anchors=activityAnchors.get(key)||[];anchors.push(time);activityAnchors.set(key,anchors);}
 function add(start:CaptureEvent,end:CaptureEvent,state:Interval['state'],s:Session|undefined,proof:Interval['proof']) {
  if(end.observedAt<start.observedAt){coverage.push({reason:'Clock rollback: interval left unknown',eventId:end.eventId});return;}
  if(end.observedAt===start.observedAt)return;
  const interval:Interval={start:start.observedAt,end:end.observedAt,state,proof,sourceEventIds:[start.eventId,end.eventId],hostId:s?.hostId,workspaceId:s?.workspaceId,sessionId:s?.sessionId,agentId:s?.agentId,provider:s?.provider,runId:s?.runId,taskId:s?.taskId,dispatchId:s?.dispatchId,child:s?.child};
  if(s){Object.assign(interval,eventMetadata.get(start)??readMetadata(start));rememberMetadata(s.key,interval);}
  intervals.push(interval);
  // Index intervals a later Dispatch binding may promote, instead of rescanning all intervals.
  if(!interval.child&&!interval.dispatchId&&interval.sessionId!==undefined){const key=agentSessionKey(interval),group=standaloneIntervals.get(key)||[];group.push(interval);standaloneIntervals.set(key,group);}
 }
 function closeKey(key:string,e:CaptureEvent,bounded=true) {
  for(const [id,a] of active){if(a.key!==key)continue;
   if(!bounded||e.observedAt-a.event.observedAt<=maxGap)add(a.event,e,a.state,a.session,bounded?'inferred':'observed');
   else {unresolved.push({reason:'Unmatched tool continuity is unknown across an observation gap',eventId:a.event.eventId});if(a.state==='running')provisional.push({event:a.event,session:a.session,key:a.key});}
   active.delete(id);
  }
 }
 /** Explicit background completion can confirm a long run; ordinary resumes cannot prove silent continuity. */
 function addBackground(b:{event:CaptureEvent;session:Session},end:CaptureEvent,proof:Interval['proof'],start=b.event.observedAt){
  if(end.observedAt<=start)return;
  const count=intervals.length;add(b.event,end,'running',b.session,proof);
  if(intervals.length>count){const interval=intervals[intervals.length-1]!;interval.background=true;interval.start=start;}
 }
 function addConfirmedBackground(b:BackgroundRun,end?:CaptureEvent){
  for(const segment of b.confirmed||[])addBackground(b,segment.end,'observed',segment.start);
  // A segment opened by a new prompt remains tentative until the task is seen running.
  if(end&&(!b.gaps?.length||b.seen))addBackground(b,end,'inferred',b.segmentStart??b.event.observedAt);
  else if(b.seen)addBackground(b,b.seen,'observed',b.segmentStart??b.event.observedAt);
  for(const gap of b.gaps||[])unresolved.push({reason:'Background shell continuity is unknown across session inactivity',eventId:gap.eventId});
 }
 function trackBackground(e:CaptureEvent,key:string,s:Session){
  // A resumed invocation reuses the conversation ID, not proof that its old
  // shells kept running while it was closed. Preserve only confirmed sightings.
  // Context compaction happens within the same invocation and is not a fence.
  if(e.kind==='session_start'&&['startup','resume'].includes(String(e.data?.source))){
   for(const [id,b] of [...background])if(nativeIdentity(b.event)===nativeIdentity(e)){
    addConfirmedBackground(b);
    unresolved.push({reason:'Background shell continuity is unknown after session restart',eventId:b.event.eventId});
    background.delete(id);
   }
  }
  const taskId=typeof e.data?.backgroundTaskId==='string'?e.data.backgroundTaskId:undefined;
  if(e.kind==='tool_end'&&taskId){if(!background.has(key+':'+taskId))background.set(key+':'+taskId,{event:e,session:s,key,taskId});return;}
  if(e.kind==='prompt_submitted'&&taskId){
   const b=background.get(key+':'+taskId);if(b){addBackground(b,e,'observed');background.delete(key+':'+taskId);}
   return;
  }
  // A new ordinary prompt is a new work episode after prolonged silence.
  // A completion notification is different: it explicitly closes the task.
  const previous=activityAnchors.get(key)?.at(-2);
  if(e.kind==='prompt_submitted'&&!taskId){
   for(const [id,b] of [...background])if(backgroundOwner(b.event)===backgroundOwner(e)){
    const last=b.key===key?previous:activityAnchors.get(b.key)?.at(-1);
    if(e.observedAt-(last??b.seen?.observedAt??b.event.observedAt)<=agentIdle)continue;
    if(b.seen)(b.confirmed??=[]).push({start:b.segmentStart??b.event.observedAt,end:b.seen});
    (b.gaps??=[]).push(e);b.segmentStart=e.observedAt;b.seen=undefined;
    if(b.key!==key){background.delete(id);b.key=key;background.set(key+':'+b.taskId,b);}
   }
  }
  // Stop lists the shells still running: a shell missing from it finished at the latest then.
  if(e.kind==='response_stop'&&Array.isArray(e.data?.backgroundTasks)){
   const running=new Set(e.data.backgroundTasks);
   for(const [id,b] of [...background])if(b.key===key){
    if(running.has(b.taskId))b.seen=e;else{addConfirmedBackground(b,e);background.delete(id);}
   }
  }
  // Ending the session stops its shells.
  if(e.kind==='session_end')for(const [id,b] of [...background])if(b.key===key){
   if(e.observedAt-(previous??b.seen?.observedAt??b.event.observedAt)>agentIdle){
    addConfirmedBackground(b);
    unresolved.push({reason:'Background shell end follows unconfirmed session inactivity',eventId:e.eventId});
   }else addConfirmedBackground(b,e);
   background.delete(id);
  }
 }
 function applyBinding(e:CaptureEvent,b:CaptureEvent):CaptureEvent {return {...e,workspaceId:b.workspaceId,runId:b.runId,taskId:b.taskId,dispatchId:b.dispatchId};}
 function resolve(e:CaptureEvent):CaptureEvent {
  if(!e.sessionId)return e;
  if(e.kind==='session_start'&&['startup','resume'].includes(String(e.data?.source))){
   const native=nativeIdentity(e);
   promotedBindings.delete(native);
   for(const [id,binding] of bindings)if(nativeIdentity(binding)===native)bindings.delete(id);
   // toolBindings deliberately survives: late tool ends still belong to their original invocation.
  }
  const closing=['tool_end','response_stop','session_end','child_stop'].includes(e.kind);
  const originalTool=e.kind==='tool_end'?toolBindings.get(toolIdentity(e)):undefined;
  if(originalTool&&(originalTool.dispatchId||!e.dispatchId))return applyBinding(e,originalTool);
  if(!e.terminalHandle){
   const key=nativeIdentity(e);
   // A new invocation without Orca metadata does not inherit a previous run.
   if(e.kind==='session_start'){promotedBindings.delete(key);return e;}
   const promoted=promotedBindings.get(key);return promoted?applyBinding(e,promoted):e;
  }
  const known=bindings.get(identity(e));
  // Late closures remain with their original session, even after the terminal hosts another Dispatch.
  if(known&&(!['session_start','prompt_submitted'].includes(e.kind)||closing))return applyBinding(e,known);
  const candidates=workerSnapshots.get(workerKey(e))||[];
  let low=0,high=candidates.length;
  while(low<high){const mid=(low+high)>>>1;if(candidates[mid].observedAt<=e.observedAt)low=mid+1;else high=mid;}
  let beforeIndex=low-1;
  while(beforeIndex>0&&candidates[beforeIndex-1].observedAt===candidates[beforeIndex].observedAt)beforeIndex--;
  const before=candidates[beforeIndex],after=candidates[low];
  // An unchanged worker that is not fresh is stored once per heartbeat, so its
  // latest snapshot describes the terminal until the next heartbeat is due.
  const reach=before&&before.data?.fresh!==true?Math.max(maxGap,workerSnapshotValidSeconds):maxGap;
  const match=before&&e.observedAt-before.observedAt<=reach?before:after&&after.observedAt-e.observedAt<=maxGap?after:undefined;
  if(!match||match.data?.takeover||settled(match)||closing)return e;
  if(e.terminalIncarnation&&match.terminalIncarnation&&e.terminalIncarnation!==match.terminalIncarnation)return e;
  const result=applyBinding(e,match);bindings.set(identity(e),result);return result;
 }
 for(const original of events) {
  const e=original.source==='hook'?resolve(original):original;
  if(e.kind==='coverage'){coverage.push({reason:String(e.data?.reason||'Missing observations'),source:e.source,eventId:e.eventId});continue;}
  if(e.kind==='capture_settings'){
   const previous=e.data?.previous as Record<string,boolean>|undefined,next=e.data?.surfaces as Record<string,boolean>|undefined;
   const changed=(key:string)=>previous?.[key]!==next?.[key];
   if(changed('macosActivity'))activityPrevious=undefined;
   if(changed('orcaPolling'))workerPrevious.clear();
   const affected=(event:CaptureEvent)=>changed(event.provider?`${event.provider}Hooks`:'');
   for(const [key,binding] of promotedBindings)if(affected(binding))promotedBindings.delete(key);
   for(const [id,a] of active)if(affected(a.event)){coverage.push({reason:'Tool timing interrupted by capture setting change',eventId:e.eventId});if(a.state==='running')provisional.push({event:a.event,session:a.session,key:a.key});a.session.state='unknown';active.delete(id);}
   for(const [key,c] of childLifecycle)if(affected(c)){coverage.push({reason:'Native child timing interrupted by capture setting change',eventId:e.eventId});childLifecycle.delete(key);}
   for(const [key,start] of turnStarts)if(affected(start)){coverage.push({reason:'Turn timing interrupted by capture setting change',eventId:e.eventId});turnStarts.delete(key);}
   globalFences.push(e.observedAt);
   continue;
  }
  if(['sleep','capture_stop','capture_start'].includes(e.kind)){
   globalFences.push(e.observedAt);
   activityPrevious=undefined;workerPrevious.clear();promotedBindings.clear();
   for(const a of active.values()){coverage.push({reason:'Active tool interrupted by capture/sleep boundary',eventId:e.eventId});if(a.state==='running')provisional.push({event:a.event,session:a.session,key:a.key});a.session.state='unknown';}
   for(const c of childLifecycle.values())coverage.push({reason:'Native child continuity interrupted by capture/sleep boundary',eventId:c.eventId});
   for(const start of turnStarts.values())coverage.push({reason:'Turn continuity interrupted by capture/sleep boundary',eventId:start.eventId});
   active.clear();childLifecycle.clear();turnStarts.clear();continue;
  }
  if(e.kind==='worker'){
   const key=agentSessionKey({...e,child:false}),s=getSession(key,e),prev=workerPrevious.get(key),done=settled(e);
   if(done||e.data?.takeover)for(const [native,binding] of promotedBindings)if(binding.hostId===e.hostId&&binding.dispatchId===e.dispatchId)promotedBindings.delete(native);
   if(done){closeKey(key,e);const turn=turnStarts.get(key);if(turn){unresolved.push({reason:'Turn ended without a response stop',eventId:turn.eventId});turnStarts.delete(key);}sessionFences.set(key,[...(sessionFences.get(key)||[]),e.observedAt]);}
   const fresh=e.data?.fresh===true&&e.data?.takeover!==true&&!done;
   if(fresh&&e.data?.state==='working')rememberActivity(key,e.observedAt);
   s.state=done?'completed':fresh?String(e.data?.state||'unknown'):'unknown';s.proof=fresh?'inferred':done?'observed':'unresolved';
   if(prev&&fresh&&prev.data?.fresh===true&&!prev.data?.takeover&&!settled(prev)&&e.data?.state===prev.data?.state&&['working','waiting'].includes(String(e.data?.state))){
    const delta=e.observedAt-prev.observedAt;
    if(e.collectorEpoch===prev.collectorEpoch&&delta>=0&&delta<=maxGap)add(prev,e,e.data?.state==='working'?'running':'waiting',s,'inferred');
    else coverage.push({reason:'Observation gap or collector restart: duration unknown',eventId:e.eventId});
   }
   workerPrevious.set(key,e);continue;
  }
  if(e.kind==='activity'){
   const prev=activityPrevious;
   if(prev&&prev.collectorEpoch===e.collectorEpoch&&e.observedAt-prev.observedAt>0&&e.observedAt-prev.observedAt<=maxGap){
    const a=prev.data?.idleSeconds,b=e.data?.idleSeconds;
    if(typeof a==='number'&&typeof b==='number'&&a<idle&&b<idle){
     add(prev,e,'human',undefined,'inferred');
     const interval=intervals.at(-1)!;
     if(prev.data?.foregroundBundleId===e.data?.foregroundBundleId){
      interval.foregroundBundleId=String(e.data?.foregroundBundleId||'');
      interval.foregroundName=String(e.data?.foregroundName||prev.data?.foregroundName||'');
     }
     const selected=prev.data?.orcaSelectedTabTitle;
     if(prev.data?.foregroundBundleId==='com.stablyai.orca'&&e.data?.foregroundBundleId==='com.stablyai.orca'&&typeof selected==='string'&&selected===e.data?.orcaSelectedTabTitle)interval.tabTitle=selected;
     if(prev.data?.foregroundBundleId==='com.stablyai.orca'&&e.data?.foregroundBundleId==='com.stablyai.orca'&&prev.workspaceId&&prev.workspaceId===e.workspaceId){interval.workspaceId=prev.workspaceId;interval.attributionSource='orca-worktree';interval.attributionReason='Same Orca worktree in both foreground observations';}
     const domain=prev.data?.browserDomain;
     if(typeof domain==='string'&&domain===e.data?.browserDomain&&prev.data?.foregroundBundleId===e.data?.foregroundBundleId){
      interval.browserDomain=domain;interval.browserBundleId=String(e.data?.foregroundBundleId);
      const origin=(data:CaptureEvent['data'])=>{try{return typeof data?.browserUrl==='string'?new URL(data.browserUrl).origin:undefined;}catch{return undefined;}};
      const previousOrigin=origin(prev.data),nextOrigin=origin(e.data);
      if(previousOrigin&&previousOrigin===nextOrigin){
       interval.browserOrigin=previousOrigin;
       if(prev.workspaceId&&prev.workspaceId===e.workspaceId){
        interval.workspaceId=prev.workspaceId;
        const first=prev.data?.websiteAttribution as Record<string,unknown>|undefined,second=e.data?.websiteAttribution as Record<string,unknown>|undefined;
        if(first&&second&&first.source===second.source&&first.projectPath===second.projectPath){interval.attributionSource=String(first.source||'website');interval.attributionReason=String(first.detail||'Same website project in both observations');}
        else{interval.attributionSource='website';interval.attributionReason='Same website project in both observations';}
       }else if(prev.workspaceId&&e.workspaceId&&prev.workspaceId!==e.workspaceId){interval.attributionSource='conflict';interval.attributionReason='Conflicting project observations';}
      }
      if(typeof prev.data?.browserUrl==='string'&&prev.data.browserUrl===e.data?.browserUrl){
       interval.browserUrl=prev.data.browserUrl;
       interval.browserTitle=String(e.data?.browserTitle||prev.data.browserTitle||domain);
      }
     }
     const tabId=prev.data?.tabId;
     if(typeof tabId==='string'&&tabId===e.data?.tabId&&prev.workspaceId===e.workspaceId&&prev.terminalHandle===e.terminalHandle){
      interval.workspaceId=prev.workspaceId;interval.tabId=tabId;interval.terminalHandle=prev.terminalHandle;interval.tabTitle=String(e.data?.tabTitle||prev.data?.tabTitle||'Orca tab');
     }
    }
   }
   activityPrevious=e;continue;
  }
  if(e.source!=='hook')continue;
  if(!e.terminalHandle&&!e.dispatchId&&!hasNativeSessionIdentity(e)){unresolved.push({reason:'Hook has no complete native session identity or verified terminal binding; cwd is insufficient',eventId:e.eventId});continue;}
  const child=Boolean(e.agentId),key=agentSessionKey({...e,child});
  const s=getSession(key,e,child);s.sessionId=e.sessionId||s.sessionId;s.provider=e.provider||s.provider;s.cwd=e.cwd||s.cwd;s.workspaceId=e.workspaceId||s.workspaceId;s.proof='observed';
  if(!child&&e.dispatchId&&['session_start','prompt_submitted','tool_start'].includes(e.kind))promotedBindings.set(nativeIdentity(e),e);
  if(!child&&e.kind==='session_end')promotedBindings.delete(nativeIdentity(e));
  if(!e.sessionId){unresolved.push({reason:'Hook missing provider session ID',eventId:e.eventId});continue;}
  rememberActivity(key,e.observedAt);
  if(e.kind==='child_start'){childLifecycle.set(key,e);s.state='running';continue;}
  if(e.kind==='child_stop'){
   const start=childLifecycle.get(key);
   if(start){add(start,e,'running',s,'observed');childLifecycle.delete(key);}
   else {unresolved.push({reason:'Native child end has no observed start',eventId:e.eventId});s.proof='unresolved';}
  }
  trackBackground(e,key,s);
  if(s.state==='completed'&&!child)continue;
  if(e.kind==='prompt_submitted'){
   const previous=turnStarts.get(key);if(previous)unresolved.push({reason:'Turn replaced before a response stop',eventId:previous.eventId});
   turnStarts.set(key,e);
  }else if(e.kind==='response_stop'){
   const start=turnStarts.get(key);if(start){add(start,e,'turn',s,'observed');turnStarts.delete(key);}
  }else if(['interrupted','session_end','child_stop'].includes(e.kind)){
   const start=turnStarts.get(key);if(start){unresolved.push({reason:'Turn ended without a response stop',eventId:start.eventId});turnStarts.delete(key);}
   sessionFences.set(key,[...(sessionFences.get(key)||[]),e.observedAt]);
  }
  if(e.kind==='tool_start'){
   const wait=active.get(key+':waiting');if(wait){add(wait.event,e,'waiting',s,'observed');active.delete(key+':waiting');}
   const id=key+':'+String(e.data?.toolId||'anonymous'),prior=active.get(id);
   if(prior){unresolved.push({reason:'Tool start replaced an unclosed execution',eventId:prior.event.eventId});if(prior.state==='running')provisional.push({event:prior.event,session:prior.session,key:prior.key});}
   active.set(id,{event:e,state:'running',session:s,key});toolBindings.set(toolIdentity(e),e);s.state='running';
  }else if(e.kind==='tool_end'){
   const id=key+':'+String(e.data?.toolId||'anonymous'),start=active.get(id);
   if(start){add(start.event,e,'running',s,'observed');active.delete(id);}
   else unresolved.push({reason:'Tool end has no matching observed start',eventId:e.eventId});
   s.state=[...active.values()].some(a=>a.key===key)?'running':'between tools';
  }else if(e.kind==='waiting'){
   closeKey(key,e);active.set(key+':waiting',{event:e,state:'waiting',session:s,key});s.state='waiting';
  }else if(['response_stop','session_end','child_stop','interrupted'].includes(e.kind)){
   closeKey(key,e);s.state=e.kind==='interrupted'?'interrupted':'idle';
  }else if(e.kind==='prompt_submitted'){closeKey(key,e);s.state='pending';}
 }
 for(const a of active.values()){
  unresolved.push({reason:'Open tool has no observed end; credited one provisional minute without extending to now',eventId:a.event.eventId});
  if(a.state==='running')provisional.push({event:a.event,session:a.session,key:a.key});
 }
 // A shell still running is credited up to the last Stop that listed it, never extended to now.
 for(const b of background.values())addConfirmedBackground(b);
 for(const c of childLifecycle.values())unresolved.push({reason:'Native child has no observed end; not extended to now',eventId:c.eventId});
 for(const start of turnStarts.values())unresolved.push({reason:'Open turn has no observed response stop; not extended to now',eventId:start.eventId});
 for(const anchors of activityAnchors.values())anchors.sort((a,b)=>a-b);
 const running=intervals.filter(i=>i.state==='running'),timed=intervals.filter(i=>i.state==='running'||i.state==='turn'),roots=new Map<string,Array<[number,number]>>(),children=new Map<string,Array<[number,number]>>(),observedRoots=new Map<string,Array<[number,number]>>(),observedChildren=new Map<string,Array<[number,number]>>();
 const intervalKey=agentSessionKey;
 const idleGaps=new Map<string,Array<[number,number]>>();
 const capped=(i:Interval,key:string):Array<[number,number]>=>{
  if(i.background)return [[i.start,i.end]];
  const anchors=activityAnchors.get(key)||[];
  let low=0,high=anchors.length;
  while(low<high){const mid=(low+high)>>>1;if(anchors[mid]!<=i.start)low=mid+1;else high=mid;}
  const first=low;
  high=anchors.length;
  while(low<high){const mid=(low+high)>>>1;if(anchors[mid]!<i.end)low=mid+1;else high=mid;}
  const cuts=[i.start,...anchors.slice(first,low),i.end],parts:Array<[number,number]>=[];
  for(let index=1;index<cuts.length;index++){
   const start=cuts[index-1]!,end=cuts[index]!,countedEnd=Math.min(end,start+agentIdle);
   if(countedEnd>start)parts.push([start,countedEnd]);
   if(countedEnd<end){const gaps=idleGaps.get(key)||[];gaps.push([countedEnd,end]);idleGaps.set(key,gaps);}
  }
  return parts;
 };
 const waitingByKey=new Map<string,Array<[number,number]>>();
 for(const i of intervals.filter(i=>i.state==='waiting')){const key=intervalKey(i),ranges=waitingByKey.get(key)||[];ranges.push([i.start,i.end]);waitingByKey.set(key,ranges);}
 // Global fences are indexed once; each key adds its own waits, idle gaps and fences.
 // A key's ranges are final once built, so its grouping is computed once.
 const globalIndex=new BlockerIndex(globalFences.map(t=>[t,t] as [number,number])),groupedByKey=new Map<string,Array<[number,number]>>();
 const grouped=(key:string,ranges:Array<[number,number]>)=>{
  const cached=groupedByKey.get(key);if(cached)return cached;
  const own=new BlockerIndex([...(waitingByKey.get(key)||[]),...(idleGaps.get(key)||[]),...(sessionFences.get(key)||[]).map(t=>[t,t] as [number,number])]);
  const result=groupIntervals(ranges,60,[globalIndex,own]);groupedByKey.set(key,result);return result;
 };
 for(const i of running){const group=i.child?observedChildren:observedRoots,key=intervalKey(i);const ranges=group.get(key)||[];ranges.push(...capped(i,key));group.set(key,ranges);}
 for(const i of timed){
  const group=i.child?children:roots,key=intervalKey(i),ranges=group.get(key)||[];
  let parts:Array<[number,number]>=[[i.start,i.end]];
  if(i.state==='turn')for(const [from,to] of waitingByKey.get(key)||[]){
   parts=parts.flatMap(([start,end]):Array<[number,number]>=>from>=end||to<=start?[[start,end]]:([[start,Math.min(from,end)],[Math.max(to,start),end]] as Array<[number,number]>).filter(([a,b])=>b>a));
  }
  ranges.push(...parts.flatMap(([start,end])=>capped({...i,start,end},key)));group.set(key,ranges);
 }
 for(const {event,session,key} of provisional){
  const group=session.child?children:roots,ranges=group.get(key)||[];
  ranges.push([event.observedAt,event.observedAt+0.001]);group.set(key,ranges);rememberMetadata(key,eventMetadata.get(event)??readMetadata(event));
 }
 const rootSeconds=new Map([...roots].map(([key,ranges])=>[key,minuteCreditSeconds(grouped(key,ranges))]));
 const childSeconds=new Map([...children].map(([key,ranges])=>[key,minuteCreditSeconds(grouped(key,ranges))]));
 for(const s of sessions.values()){
  const key=s.key;
  s.seconds=(s.child?childSeconds:rootSeconds).get(key)||0;
  s.observedSeconds=unionSeconds((s.child?observedChildren:observedRoots).get(key)||[]);
  for(const [start,end] of grouped(key,(s.child?children:roots).get(key)||[]))intervals.push({start,end,state:'grouped',proof:'inferred',sourceEventIds:[],...commonByKey.get(key),hostId:s.hostId,workspaceId:s.workspaceId,sessionId:s.sessionId,agentId:s.agentId,provider:s.provider,runId:s.runId,taskId:s.taskId,dispatchId:s.dispatchId,child:s.child});
 }
 const groupedActivity=[...roots,...children].flatMap(([key,ranges])=>grouped(key,ranges));
 const humanRanges=intervals.filter(i=>i.state==='human').map(i=>[i.start,i.end] as [number,number]);
 const issueIds=new Set([...coverage,...unresolved].map(issue=>issue.eventId).filter((id):id is string=>Boolean(id)));
 const observedAt=new Map<string,number>();
 for(const event of unique)if(issueIds.has(event.eventId))observedAt.set(event.eventId,event.observedAt);
 const dated=(issues:Issue[])=>issues.map(issue=>({...issue,observedAt:issue.eventId?observedAt.get(issue.eventId):undefined}));
 return {intervals,unresolved:dated(unresolved),coverage:dated(coverage),sessions:[...sessions.values()],humanSeconds:minuteCreditSeconds(humanRanges),agentSeconds:[...roots].reduce((sum,[key,r])=>sum+minuteCreditSeconds(grouped(key,r)),0),childAgentSeconds:[...children].reduce((sum,[key,r])=>sum+minuteCreditSeconds(grouped(key,r)),0),elapsedSeconds:minuteCreditSeconds([...groupedActivity,...humanRanges])};
}
