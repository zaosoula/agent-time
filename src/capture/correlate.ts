import type { CaptureEvent, Interval, Issue, Session, Summary } from './events.ts';

export function unionSeconds(intervals: Array<[number,number]>): number {
  const merged:Array<[number,number]>=[];
  for(const [start,end] of [...intervals].sort((a,b)=>a[0]-b[0])) {
    if(!Number.isFinite(start)||!Number.isFinite(end)||end<start)throw new Error('invalid interval');
    const last=merged.at(-1);if(last&&start<=last[1])last[1]=Math.max(last[1],end);else merged.push([start,end]);
  }
  return merged.reduce((sum,[s,e])=>sum+e-s,0);
}
export function summarize(input: CaptureEvent[], options: { idleThreshold?:number; maxGap?:number } = {}): Summary {
  const maxGap=options.maxGap??15, idle=options.idleThreshold??300;
  const events=[...new Map(input.map(e=>[e.eventId,e])).values()].sort((a,b)=>
    a.collectorEpoch===b.collectorEpoch?a.monotonicAt-b.monotonicAt||a.eventId.localeCompare(b.eventId):a.observedAt-b.observedAt||a.eventId.localeCompare(b.eventId));
  const intervals:Interval[]=[],unresolved:Issue[]=[],coverage:Issue[]=[],sessions=new Map<string,Session>();
  const workerPrevious=new Map<string,CaptureEvent>();
  const active=new Map<string,{event:CaptureEvent;state:'running'|'waiting';session:Session}>();
  const workerSnapshots=events.filter(e=>e.kind==='worker');
  let activityPrevious:CaptureEvent|undefined;
  function getSession(key:string,e:CaptureEvent,child=false):Session {
    let s=sessions.get(key);
    if(!s){s={key,workspaceId:e.workspaceId,cwd:e.cwd,runId:e.runId,taskId:e.taskId,dispatchId:e.dispatchId,
      sessionId:e.sessionId,agentId:e.agentId,provider:e.provider,terminalHandle:e.terminalHandle,
      title:String(e.data?.title||`${e.provider||'Agent'} ${child?'subagent':'session'}`),state:'unknown',lastObservedAt:e.observedAt,seconds:0,child,proof:'unresolved'};sessions.set(key,s);}
    s.lastObservedAt=Math.max(s.lastObservedAt,e.observedAt);
    return s;
  }
  function add(start:CaptureEvent,end:CaptureEvent,state:Interval['state'],s:Session|undefined,proof:Interval['proof']) {
    if(end.observedAt<start.observedAt){coverage.push({reason:'Clock rollback: interval left unknown',eventId:end.eventId});return;}
    if(end.observedAt===start.observedAt)return;
    intervals.push({start:start.observedAt,end:end.observedAt,state,proof,sourceEventIds:[start.eventId,end.eventId],
      workspaceId:s?.workspaceId,sessionId:s?.sessionId,agentId:s?.agentId,provider:s?.provider,runId:s?.runId,taskId:s?.taskId,dispatchId:s?.dispatchId,child:s?.child});
  }
  function resolve(e:CaptureEvent):CaptureEvent {
    if(!e.terminalHandle)return e;
    const candidates=workerSnapshots.filter(w=>w.terminalHandle===e.terminalHandle && w.hostId===e.hostId && Math.abs(w.observedAt-e.observedAt)<=maxGap);
    const before=candidates.filter(w=>w.observedAt<=e.observedAt).sort((a,b)=>b.observedAt-a.observedAt);
    const match=before[0]||candidates.sort((a,b)=>a.observedAt-b.observedAt)[0];
    if(!match || match.data?.takeover || ['succeeded','failed','completed'].includes(String(match.data?.outcome)))return e;
    if(e.terminalIncarnation&&match.terminalIncarnation&&e.terminalIncarnation!==match.terminalIncarnation)return e;
    return {...e,workspaceId:match.workspaceId,runId:match.runId,taskId:match.taskId,dispatchId:match.dispatchId};
  }
  for(const original of events) {
    const e=original.source==='hook'?resolve(original):original;
    if(e.kind==='coverage'){coverage.push({reason:String(e.data?.reason||'Missing observations'),source:e.source});continue;}
    if(e.kind==='sleep'||e.kind==='capture_stop'){
      activityPrevious=undefined;workerPrevious.clear();
      for(const [key,a] of active){coverage.push({reason:'Active turn interrupted by capture/sleep boundary',eventId:e.eventId});a.session.state='unknown';active.delete(key);}continue;
    }
    if(e.kind==='worker') {
      const key=`dispatch:${e.hostId}:${e.dispatchId}`,s=getSession(key,e),prev=workerPrevious.get(key);
      const settled=['succeeded','failed','completed','cancelled','abandoned'].includes(String(e.data?.outcome));
      const fresh=e.data?.fresh===true && e.data?.takeover!==true && !settled;
      s.state=settled?'completed':fresh?String(e.data?.state||'unknown'):'unknown';s.proof=fresh?'inferred':settled?'observed':'unresolved';
      if(prev&&fresh&&prev.data?.fresh===true&&!prev.data?.takeover && e.data?.state===prev.data?.state && ['working','waiting'].includes(String(e.data?.state))) {
        const delta=e.observedAt-prev.observedAt;
        if(e.collectorEpoch===prev.collectorEpoch&&delta>=0&&delta<=maxGap)add(prev,e,e.data?.state==='working'?'running':'waiting',s,'inferred');
        else coverage.push({reason:'Observation gap or collector restart: duration unknown',eventId:e.eventId});
      }
      workerPrevious.set(key,e);continue;
    }
    if(e.kind==='activity') {
      const prev=activityPrevious;
      if(prev&&prev.collectorEpoch===e.collectorEpoch&&e.observedAt-prev.observedAt>=0&&e.observedAt-prev.observedAt<=maxGap) {
        const a=prev.data?.idleSeconds,b=e.data?.idleSeconds;
        if(typeof a==='number'&&typeof b==='number'&&a<idle&&b<idle)add(prev,e,'human',undefined,'inferred');
      }
      activityPrevious=e;continue;
    }
    if(e.source!=='hook')continue;
    const child=Boolean(e.agentId),key=child?`child:${e.sessionId}:${e.agentId}`:e.dispatchId?`dispatch:${e.hostId}:${e.dispatchId}`:`session:${e.hostId}:${e.sessionId}`;
    const s=getSession(key,e,child);s.sessionId=e.sessionId||s.sessionId;
    s.cwd=e.cwd||s.cwd;s.workspaceId=e.workspaceId||s.workspaceId;s.proof=e.terminalHandle?'observed':'unresolved';
    if(!e.terminalHandle&&!e.dispatchId){unresolved.push({reason:'Session has no verified terminal binding; cwd is insufficient',eventId:e.eventId});continue;}
    if(!e.sessionId){unresolved.push({reason:'Hook missing provider session ID',eventId:e.eventId});continue;}
    const previous=active.get(key);
    if(['tool_start','waiting'].includes(e.kind)) {
      const state=e.kind==='waiting'?'waiting':'running';
      if(previous && previous.state!==state){add(previous.event,e,previous.state,s,'observed');active.delete(key);}
      if(!active.has(key))active.set(key,{event:e,state,session:s});
      s.state=state;
    } else if(['tool_end','response_stop','session_end','child_stop','interrupted'].includes(e.kind)) {
      if(previous){add(previous.event,e,previous.state,s,'observed');active.delete(key);}
      s.state=e.kind==='tool_end'?'between tools':e.kind==='interrupted'?'interrupted':'idle';
    } else if(e.kind==='prompt_submitted'){s.state='pending';}
  }
  for(const pending of active.values()) {
    unresolved.push({reason:'Open turn has no observed end; not extended to now',eventId:pending.event.eventId});
  }
  const running=intervals.filter(i=>i.state==='running');
  // Hooks and polling can overlap for the same dispatch: union within each root session before summing.
  const roots=new Map<string,Array<[number,number]>>(),children=new Map<string,Array<[number,number]>>();
  for(const i of running){const group=i.child?children:roots;const key=i.child?`${i.sessionId}:${i.agentId}`:i.dispatchId?`dispatch:${i.dispatchId}`:`session:${i.sessionId}`;const ranges=group.get(key)||[];ranges.push([i.start,i.end]);group.set(key,ranges);}
  for(const s of sessions.values()) {
    s.seconds=unionSeconds(running.filter(i=>s.child?i.child&&i.sessionId===s.sessionId&&i.agentId===s.agentId:s.dispatchId?i.dispatchId===s.dispatchId&&!i.child:i.sessionId===s.sessionId&&!i.child).map(i=>[i.start,i.end]));
  }
  return {intervals,unresolved,coverage,sessions:[...sessions.values()],
    humanSeconds:unionSeconds(intervals.filter(i=>i.state==='human').map(i=>[i.start,i.end])),
    agentSeconds:[...roots.values()].reduce((sum,r)=>sum+unionSeconds(r),0),
    childAgentSeconds:[...children.values()].reduce((sum,r)=>sum+unionSeconds(r),0),
    elapsedSeconds:unionSeconds(intervals.filter(i=>i.state!=='waiting').map(i=>[i.start,i.end]))};
}
