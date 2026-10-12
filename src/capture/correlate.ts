import type { CaptureEvent, Interval, Issue, Session, Summary } from './events.ts';
export function unionSeconds(intervals:Array<[number,number]>):number {
 const merged:Array<[number,number]>=[];
 for(const [start,end] of [...intervals].sort((a,b)=>a[0]-b[0])) {
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<start)throw new Error('invalid interval');
  const last=merged.at(-1);if(last&&start<=last[1])last[1]=Math.max(last[1],end);else merged.push([start,end]);
 }
 return merged.reduce((sum,[start,end])=>sum+end-start,0);
}
const settled=(e:CaptureEvent)=>['succeeded','failed','completed','cancelled','abandoned'].includes(String(e.data?.outcome));
export function summarize(input:CaptureEvent[],options:{idleThreshold?:number;maxGap?:number}={}):Summary {
 const maxGap=options.maxGap??15,idle=options.idleThreshold??300;
 const unique=[...new Map(input.map(e=>[e.eventId,e])).values()];
 // Preserve per-epoch causal order even when wall time rolls backwards, with a transitive global ordering.
 const epochGroups=new Map<string,CaptureEvent[]>();
 for(const e of unique){const group=epochGroups.get(e.collectorEpoch)||[];group.push(e);epochGroups.set(e.collectorEpoch,group);}
 const sortTime=new Map<string,number>();
 for(const group of epochGroups.values()){let time=-Infinity;for(const e of group.sort((a,b)=>a.monotonicAt-b.monotonicAt||a.eventId.localeCompare(b.eventId))){time=Math.max(time,e.observedAt);sortTime.set(e.eventId,time);}}
 const events=unique.sort((a,b)=>sortTime.get(a.eventId)!-sortTime.get(b.eventId)!||(a.collectorEpoch===b.collectorEpoch?a.monotonicAt-b.monotonicAt:0)||a.eventId.localeCompare(b.eventId));
 const intervals:Interval[]=[],unresolved:Issue[]=[],coverage:Issue[]=[],sessions=new Map<string,Session>();
 const workerPrevious=new Map<string,CaptureEvent>(),childLifecycle=new Map<string,CaptureEvent>();
 const active=new Map<string,{event:CaptureEvent;state:'running'|'waiting';session:Session;key:string}>();
 const bindings=new Map<string,CaptureEvent>(),toolBindings=new Map<string,CaptureEvent>();
 const workerSnapshots=events.filter(e=>e.kind==='worker');let activityPrevious:CaptureEvent|undefined;
 const identity=(e:CaptureEvent)=>`${e.hostId}:${e.sessionId}:${e.terminalHandle}`;
 const toolIdentity=(e:CaptureEvent)=>`${identity(e)}:${e.agentId||'root'}:${String(e.data?.toolId||'anonymous')}`;
 function getSession(key:string,e:CaptureEvent,child=false):Session {
  let s=sessions.get(key);
  if(!s){s={key,hostId:e.hostId,workspaceId:e.workspaceId,cwd:e.cwd,runId:e.runId,taskId:e.taskId,dispatchId:e.dispatchId,sessionId:e.sessionId,agentId:e.agentId,provider:e.provider,terminalHandle:e.terminalHandle,title:String(e.data?.title||`${child?(e.data?.childType||e.provider||'Native'):e.provider||'Agent'} ${child?'subagent':'session'}`),state:'unknown',lastObservedAt:e.observedAt,seconds:0,child,proof:'unresolved'};sessions.set(key,s);}
  s.lastObservedAt=Math.max(s.lastObservedAt,e.observedAt);return s;
 }
 function add(start:CaptureEvent,end:CaptureEvent,state:Interval['state'],s:Session|undefined,proof:Interval['proof']) {
  if(end.observedAt<start.observedAt){coverage.push({reason:'Clock rollback: interval left unknown',eventId:end.eventId});return;}
  if(end.observedAt===start.observedAt)return;
  intervals.push({start:start.observedAt,end:end.observedAt,state,proof,sourceEventIds:[start.eventId,end.eventId],hostId:s?.hostId,workspaceId:s?.workspaceId,sessionId:s?.sessionId,agentId:s?.agentId,provider:s?.provider,runId:s?.runId,taskId:s?.taskId,dispatchId:s?.dispatchId,child:s?.child});
 }
 function closeKey(key:string,e:CaptureEvent,bounded=true) {
  for(const [id,a] of active){if(a.key!==key)continue;
   if(!bounded||e.observedAt-a.event.observedAt<=maxGap)add(a.event,e,a.state,a.session,bounded?'inferred':'observed');
   else unresolved.push({reason:'Unmatched tool continuity is unknown across an observation gap',eventId:a.event.eventId});
   active.delete(id);
  }
 }
 function applyBinding(e:CaptureEvent,b:CaptureEvent):CaptureEvent {return {...e,workspaceId:b.workspaceId,runId:b.runId,taskId:b.taskId,dispatchId:b.dispatchId};}
 function resolve(e:CaptureEvent):CaptureEvent {
  if(!e.terminalHandle||!e.sessionId)return e;
  const closing=['tool_end','response_stop','session_end','child_stop'].includes(e.kind);
  const originalTool=e.kind==='tool_end'?toolBindings.get(toolIdentity(e)):undefined;
  if(originalTool)return applyBinding(e,originalTool);
  const known=bindings.get(identity(e));
  // Late closures remain with their original session, even after the terminal hosts another Dispatch.
  if(known&&(!['session_start','prompt_submitted'].includes(e.kind)||closing))return applyBinding(e,known);
  const candidates=workerSnapshots.filter(w=>w.terminalHandle===e.terminalHandle&&w.hostId===e.hostId&&Math.abs(w.observedAt-e.observedAt)<=maxGap);
  const before=candidates.filter(w=>w.observedAt<=e.observedAt).sort((a,b)=>b.observedAt-a.observedAt);
  const match=before[0]||candidates.sort((a,b)=>a.observedAt-b.observedAt)[0];
  if(!match||match.data?.takeover||settled(match)||closing)return e;
  if(e.terminalIncarnation&&match.terminalIncarnation&&e.terminalIncarnation!==match.terminalIncarnation)return e;
  const result=applyBinding(e,match);bindings.set(identity(e),result);return result;
 }
 for(const original of events) {
  const e=original.source==='hook'?resolve(original):original;
  if(e.kind==='coverage'){coverage.push({reason:String(e.data?.reason||'Missing observations'),source:e.source});continue;}
  if(['sleep','capture_stop','capture_start'].includes(e.kind)){
   activityPrevious=undefined;workerPrevious.clear();
   for(const a of active.values()){coverage.push({reason:'Active tool interrupted by capture/sleep boundary',eventId:e.eventId});a.session.state='unknown';}
   for(const c of childLifecycle.values())coverage.push({reason:'Native child continuity interrupted by capture/sleep boundary',eventId:c.eventId});
   active.clear();childLifecycle.clear();continue;
  }
  if(e.kind==='worker'){
   const key=`dispatch:${e.hostId}:${e.dispatchId}`,s=getSession(key,e),prev=workerPrevious.get(key),done=settled(e);
   if(done)closeKey(key,e);
   const fresh=e.data?.fresh===true&&e.data?.takeover!==true&&!done;
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
   if(prev&&prev.collectorEpoch===e.collectorEpoch&&e.observedAt-prev.observedAt>=0&&e.observedAt-prev.observedAt<=maxGap){
    const a=prev.data?.idleSeconds,b=e.data?.idleSeconds;
    if(typeof a==='number'&&typeof b==='number'&&a<idle&&b<idle)add(prev,e,'human',undefined,'inferred');
   }
   activityPrevious=e;continue;
  }
  if(e.source!=='hook')continue;
  const child=Boolean(e.agentId),key=child?`child:${e.hostId}:${e.sessionId}:${e.agentId}`:e.dispatchId?`dispatch:${e.hostId}:${e.dispatchId}`:`session:${e.hostId}:${e.sessionId}`;
  const s=getSession(key,e,child);s.sessionId=e.sessionId||s.sessionId;s.provider=e.provider||s.provider;s.cwd=e.cwd||s.cwd;s.workspaceId=e.workspaceId||s.workspaceId;s.proof=e.terminalHandle?'observed':'unresolved';
  if(!e.terminalHandle&&!e.dispatchId){unresolved.push({reason:'Session has no verified terminal binding; cwd is insufficient',eventId:e.eventId});continue;}
  if(!e.sessionId){unresolved.push({reason:'Hook missing provider session ID',eventId:e.eventId});continue;}
  if(e.kind==='child_start'){childLifecycle.set(key,e);s.state='running';continue;}
  if(e.kind==='child_stop'){
   const start=childLifecycle.get(key);
   if(start){add(start,e,'running',s,'observed');childLifecycle.delete(key);}
   else {unresolved.push({reason:'Native child end has no observed start',eventId:e.eventId});s.proof='unresolved';}
  }
  if(s.state==='completed'&&!child)continue;
  if(e.kind==='tool_start'){
   const wait=active.get(key+':waiting');if(wait){add(wait.event,e,'waiting',s,'observed');active.delete(key+':waiting');}
   const id=key+':'+String(e.data?.toolId||'anonymous'),prior=active.get(id);
   if(prior){unresolved.push({reason:'Tool start replaced an unclosed execution',eventId:prior.event.eventId});}
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
 for(const a of active.values())unresolved.push({reason:'Open tool has no observed end; not extended to now',eventId:a.event.eventId});
 for(const c of childLifecycle.values())unresolved.push({reason:'Native child has no observed end; not extended to now',eventId:c.eventId});
 const running=intervals.filter(i=>i.state==='running'),roots=new Map<string,Array<[number,number]>>(),children=new Map<string,Array<[number,number]>>();
 for(const i of running){const group=i.child?children:roots,key=i.child?`${i.hostId}:${i.sessionId}:${i.agentId}`:i.dispatchId?`${i.hostId}:dispatch:${i.dispatchId}`:`${i.hostId}:session:${i.sessionId}`;const ranges=group.get(key)||[];ranges.push([i.start,i.end]);group.set(key,ranges);}
 for(const s of sessions.values())s.seconds=unionSeconds(running.filter(i=>i.hostId===s.hostId&&(s.child?i.child&&i.sessionId===s.sessionId&&i.agentId===s.agentId:s.dispatchId?i.dispatchId===s.dispatchId&&!i.child:i.sessionId===s.sessionId&&!i.child)).map(i=>[i.start,i.end]));
 return {intervals,unresolved,coverage,sessions:[...sessions.values()],humanSeconds:unionSeconds(intervals.filter(i=>i.state==='human').map(i=>[i.start,i.end])),agentSeconds:[...roots.values()].reduce((sum,r)=>sum+unionSeconds(r),0),childAgentSeconds:[...children.values()].reduce((sum,r)=>sum+unionSeconds(r),0),elapsedSeconds:unionSeconds(intervals.filter(i=>i.state!=='waiting').map(i=>[i.start,i.end]))};
}
