import type {CaptureEvent,Interval,Session,Summary} from './events.ts';
import {minuteCreditSeconds} from './correlate.ts';

export interface ReportedWorkItem {
 id:string;kind:'context'|'counter';title:string;issueKey?:string;project?:string;
 provider?:string;sessionId?:string;workspaceId?:string;
 start:number;end:number;active:boolean;
}

/** Declarations are context, never credited time. A context is a point; a counter is an elapsed span. */
export function reportedWorkForDay(events:CaptureEvent[],start:number,end:number,now:number):ReportedWorkItem[]{
 const starts=new Map<string,CaptureEvent>(),stops=new Map<string,number>();
 const contexts:ReportedWorkItem[]=[];
 for(const event of events){
  if(event.source!=='agent_report'||event.observedAt>=end)continue;
  if(event.kind==='task_start')starts.set(event.eventId,event);
  else if(event.kind==='task_stop')stops.set(String(event.data?.taskCounterId),event.observedAt);
  else if(event.kind==='work_context'&&event.observedAt>=start){
   const title=String(event.data?.task||event.data?.issueKey||event.data?.project||'Work context');
   contexts.push({id:event.eventId,kind:'context',title,issueKey:typeof event.data?.issueKey==='string'?event.data.issueKey:undefined,project:typeof event.data?.project==='string'?event.data.project:undefined,provider:event.provider,sessionId:event.sessionId,workspaceId:event.workspaceId,start:event.observedAt,end:event.observedAt,active:false});
  }
 }
 const counters:ReportedWorkItem[]=[];
 for(const event of starts.values()){
  const stoppedAt=stops.get(event.eventId),until=Math.min(stoppedAt??now,end);
  if(until<=start||event.observedAt>=end)continue;
  counters.push({id:event.eventId,kind:'counter',title:String(event.data?.name||'Task counter'),issueKey:typeof event.data?.issueKey==='string'?event.data.issueKey:undefined,provider:event.provider,sessionId:event.sessionId,workspaceId:event.workspaceId,start:event.observedAt,end:Math.max(event.observedAt,until),active:stoppedAt===undefined&&now<end});
 }
 return [...counters,...contexts].sort((a,b)=>b.start-a.start);
}

type Range=[number,number];
function merged(ranges:Range[]):Range[]{
 const out:Range[]=[];
 for(const [s,e] of [...ranges].filter(([s,e])=>e>s).sort((a,b)=>a[0]-b[0])){const last=out.at(-1);if(last&&s<=last[1])last[1]=Math.max(last[1],e);else out.push([s,e]);}
 return out;
}
function subtract(range:Range,covered:Range[]):Range[]{
 const out:Range[]=[];let cursor=range[0];
 for(const [s,e] of merged(covered)){if(e<=cursor||s>=range[1])continue;if(s>cursor)out.push([cursor,s]);cursor=Math.max(cursor,e);}
 if(cursor<range[1])out.push([cursor,range[1]]);
 return out;
}
const sessionKey=(item:{child?:boolean;dispatchId?:string;sessionId?:string})=>item.dispatchId?`dispatch:${item.dispatchId}`:`session:${item.sessionId??''}`;
const agentStates=new Set<Interval['state']>(['running','turn','grouped']);
/** Project root of a workspace ID or path; Orca worktrees count as their repository. */
const projectOf=(path:string|undefined)=>{const raw=path?.split('::').at(-1);return raw?.startsWith('/')?raw.split('/.orca/workspaces/')[0]!.replace(/\/+$/,'')||'/':undefined;};

/**
 * Opt-in: credit agent task counters as agent time. Only the part of a counter
 * not already covered by measured time of that agent in that project is added,
 * so measured and reported time are never counted twice. The credit goes to
 * the matching agent session, or to a session of its own.
 */
export function creditTaskCounters(summary:Summary,items:ReportedWorkItem[]):Summary{
 const counters=items.filter(item=>item.kind==='counter'&&item.end>item.start);
 if(!counters.length)return summary;
 const intervals=[...summary.intervals],sessions=summary.sessions.map(session=>({...session}));
 const sessionProjectOf=(session:Session)=>projectOf(session.workspaceId)||projectOf(session.cwd);
 const agentRangesOf=(session:Session)=>intervals.filter(i=>!i.child&&sessionKey(i)===sessionKey(session)&&agentStates.has(i.state)).map(i=>[i.start,i.end] as Range);
 let added:Range[]=[],agentDelta=0;
 for(const counter of counters){
  const span:Range=[counter.start,counter.end],project=projectOf(counter.workspaceId);
  const roots=sessions.filter(session=>!session.child&&(!counter.provider||session.provider===counter.provider));
  const peers=counter.sessionId?roots.filter(session=>session.sessionId===counter.sessionId):project?roots.filter(session=>sessionProjectOf(session)===project):[];
  const overlap=(session:Session)=>agentRangesOf(session).reduce((sum,[s,e])=>sum+Math.max(0,Math.min(e,span[1])-Math.max(s,span[0])),0);
  let session=[...peers].sort((a,b)=>overlap(b)-overlap(a)||b.lastObservedAt-a.lastObservedAt)[0];
  if(!session){
   session={key:`task-counter:${counter.id}`,sessionId:`task-counter:${counter.id}`,workspaceId:counter.workspaceId,cwd:counter.workspaceId,provider:counter.provider,title:counter.title,state:counter.active?'running':'stopped',lastObservedAt:counter.end,seconds:0,observedSeconds:0,child:false,proof:'reported'};
   sessions.push(session);
  }
  const own=agentRangesOf(session);
  const covered=(peers.includes(session)?peers:[session]).flatMap(agentRangesOf);
  const gaps=subtract(span,covered);
  if(!gaps.length)continue;
  for(const [start,end] of gaps)intervals.push({start,end,state:'running',proof:'inferred',sourceEventIds:[counter.id],hostId:session.hostId,workspaceId:session.workspaceId,sessionId:session.sessionId,agentId:session.agentId,provider:session.provider,runId:session.runId,taskId:session.taskId,dispatchId:session.dispatchId,child:false,attributionSource:'task-counter',attributionReason:`Agent task counter “${counter.title}”`});
  const credit=Math.max(0,minuteCreditSeconds([...own,...gaps])-minuteCreditSeconds(own));
  session.seconds+=credit;agentDelta+=credit;
  added=[...added,...gaps];
 }
 if(!added.length)return summary;
 const activity=summary.intervals.filter(i=>agentStates.has(i.state)||i.state==='human').map(i=>[i.start,i.end] as Range);
 const elapsedDelta=Math.max(0,minuteCreditSeconds([...activity,...added])-minuteCreditSeconds(activity));
 const agents=summary.intervals.filter(i=>agentStates.has(i.state)).map(i=>[i.start,i.end] as Range);
 const wallDelta=Math.max(0,minuteCreditSeconds([...agents,...added])-minuteCreditSeconds(agents));
 return {...summary,intervals:intervals.sort((a,b)=>a.start-b.start),sessions,agentSeconds:summary.agentSeconds+agentDelta,elapsedSeconds:summary.elapsedSeconds+elapsedDelta,
  ...(summary.mainAgentSeconds!==undefined?{mainAgentSeconds:summary.mainAgentSeconds+agentDelta}:{}),
  ...(summary.agentWallSeconds!==undefined?{agentWallSeconds:summary.agentWallSeconds+wallDelta}:{})};
}
