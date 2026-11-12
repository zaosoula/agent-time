import type {WorkAttributes} from './work-context.ts';
import type {CaptureEvent,Interval,Session,Summary} from './events.ts';
import {minuteCreditSeconds} from './correlate.ts';
import {agentSessionKey} from './session-identity.ts';

/** Resolve only referenced starts, so long-running counters survive bounded history windows. */
export function hydrateTaskStarts(events:CaptureEvent[],lookup:(id:string)=>CaptureEvent|undefined|null):CaptureEvent[]{
 const seen=new Set(events.map(e=>e.eventId)),extra:CaptureEvent[]=[];
 for(const event of events)if(event.source==='agent_report'&&['task_stop','task_heartbeat'].includes(event.kind)){
  const id=String(event.data?.taskCounterId||'');if(!id||id.length>36||seen.has(id))continue;seen.add(id);
  const start=lookup(id);if(start?.source==='agent_report'&&start.kind==='task_start')extra.push(start);
 }
 return [...extra,...events];
}
export interface AgentIdentity {id:string;name?:string;role?:string;}
export interface TaskUsage {inputTokens?:number;outputTokens?:number;cachedInputTokens?:number;cost?:number;currency?:string;source:'agent-reported'|'provider-response';}
export interface ReportedWorkItem {
 id:string;kind:'context'|'counter';title:string;issueKey?:string;project?:string;
 provider?:string;sessionId?:string;workspaceId?:string;projectPath?:string;hostId?:string;
 start:number;end:number;active:boolean;status?:'active'|'completed'|'failed'|'cancelled'|'session-ended'|'interrupted';
 attributes?:WorkAttributes;agentIdentity?:AgentIdentity;parentTaskCounterId?:string;billable?:boolean|null;usage?:TaskUsage;expiresAt?:number;
}

/** Declarations are context, never credited time. A context is a point; a counter is an elapsed span. */
/**
 * `sessionEnds` maps `provider:sessionId` to when that agent session ended: a
 * timer its agent never stopped ends with the session instead of running on.
 * A stop with `discarded` (from the app) removes the timer altogether.
 */
export function reportedWorkForDay(events:CaptureEvent[],start:number,end:number,now:number,sessionEnds:Map<string,number>=new Map()):ReportedWorkItem[]{
 const starts=new Map<string,CaptureEvent>(),stops=new Map<string,CaptureEvent>(),heartbeats=new Map<string,number>(),discarded=new Set<string>();
 const contexts:ReportedWorkItem[]=[];
 for(const event of events){
  if(event.source!=='agent_report'||event.observedAt>=end&&!['task_stop','task_heartbeat'].includes(event.kind))continue;
  if(event.kind==='task_start')starts.set(event.eventId,event);
  else if(event.kind==='task_stop'){const id=String(event.data?.taskCounterId);if(event.data?.discarded===true)discarded.add(id);if(!stops.has(id))stops.set(id,event);}
  else if(event.kind==='task_heartbeat'){const id=String(event.data?.taskCounterId);heartbeats.set(id,Math.max(heartbeats.get(id)??0,event.observedAt));}
  else if(event.kind==='work_context'&&event.observedAt>=start){
   const title=String(event.data?.task||event.data?.issueKey||event.data?.project||'Work context');
   contexts.push({id:event.eventId,kind:'context',title,issueKey:typeof event.data?.issueKey==='string'?event.data.issueKey:undefined,project:typeof event.data?.project==='string'?event.data.project:undefined,hostId:event.hostId,provider:event.provider,sessionId:event.sessionId,workspaceId:event.workspaceId,projectPath:event.projectPath,attributes:event.data?.attributes as WorkAttributes|undefined,agentIdentity:event.data?.agentIdentity as AgentIdentity|undefined,billable:event.data?.billable as boolean|null|undefined,start:event.observedAt,end:event.observedAt,active:false});
  }
 }
 // Session-end evidence is available in both app and MCP summary windows.
 for(const event of events)if(event.kind==='session_end'&&event.provider&&event.sessionId){const key=`${event.provider}:${event.sessionId}`;sessionEnds.set(key,Math.max(sessionEnds.get(key)??0,event.observedAt));}
 const counters:ReportedWorkItem[]=[];
 for(const event of starts.values()){
  if(discarded.has(event.eventId))continue;
  const sessionEnd=event.sessionId?sessionEnds.get(`${event.provider||''}:${event.sessionId}`):undefined;
  const endedWithSession=sessionEnd!==undefined&&sessionEnd>=event.observedAt?sessionEnd:undefined;
  const stop=stops.get(event.eventId),explicitEnd=stop&&stop.observedAt>=event.observedAt?stop.observedAt:undefined;
  const confirmed=Math.max(event.observedAt,heartbeats.get(event.eventId)??event.observedAt);
  // Legacy counters keep a generous 12h bound. New MCP counters renew a 15min lease.
  const expiresAt=confirmed+Number(event.data?.leaseSeconds||43200);
  const sessionClosure=endedWithSession!==undefined&&(endedWithSession<=expiresAt||explicitEnd!==undefined)?endedWithSession:undefined;
  const stoppedAt=explicitEnd===undefined?sessionClosure:sessionClosure===undefined?explicitEnd:Math.min(explicitEnd,sessionClosure);
  const interrupted=stoppedAt===undefined&&now>=expiresAt;
  const until=Math.min(stoppedAt??(interrupted?confirmed:now),end);
  const status:ReportedWorkItem['status']=stoppedAt!==undefined?(endedWithSession===stoppedAt?'session-ended':(stop?.data?.outcome as 'completed'|'failed'|'cancelled')||'completed'):interrupted?'interrupted':'active';
  if(until<start||event.observedAt>=end)continue;
  counters.push({id:event.eventId,kind:'counter',title:String(event.data?.name||'Task counter'),issueKey:typeof event.data?.issueKey==='string'?event.data.issueKey:undefined,hostId:event.hostId,provider:event.provider,sessionId:event.sessionId,workspaceId:event.workspaceId,projectPath:event.projectPath,start:event.observedAt,end:Math.max(event.observedAt,until),active:status==='active'&&now<end,status,expiresAt,project:typeof event.data?.project==='string'?event.data.project:undefined,attributes:event.data?.attributes as WorkAttributes|undefined,agentIdentity:event.data?.agentIdentity as AgentIdentity|undefined,parentTaskCounterId:event.data?.parentTaskCounterId as string|undefined,billable:event.data?.billable as boolean|null|undefined,usage:stop?.data?.usage as TaskUsage|undefined});
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
const sessionKey=agentSessionKey;
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
  const roots=sessions.filter(session=>!session.child&&(!counter.provider||session.provider===counter.provider)&&(!counter.hostId||counter.hostId===session.hostId));
  const declaredSessionId=counter.agentIdentity?`task-agent:${JSON.stringify([counter.provider||'',counter.agentIdentity.id,counter.workspaceId||''])}`:undefined;
  const peers=counter.sessionId?roots.filter(session=>session.sessionId===counter.sessionId):declaredSessionId?roots.filter(session=>session.sessionId===declaredSessionId):project?roots.filter(session=>sessionProjectOf(session)===project):[];
  const overlap=(session:Session)=>agentRangesOf(session).reduce((sum,[s,e])=>sum+Math.max(0,Math.min(e,span[1])-Math.max(s,span[0])),0);
  let session=[...peers].sort((a,b)=>overlap(b)-overlap(a)||b.lastObservedAt-a.lastObservedAt)[0];
  if(!session){
   session={hostId:counter.hostId,projectPath:counter.projectPath,agentIdentity:counter.agentIdentity,attributes:counter.attributes,metadataSource:'agent-report',key:`task-counter:${counter.id}`,sessionId:counter.sessionId||declaredSessionId||`task-counter:${counter.id}`,workspaceId:counter.workspaceId,cwd:counter.workspaceId,provider:counter.provider,title:counter.title,state:counter.active?'running':'stopped',lastObservedAt:counter.end,seconds:0,observedSeconds:0,child:false,proof:'reported'};
   sessions.push(session);
  }
  const own=agentRangesOf(session);
  const covered=(peers.includes(session)?peers:[session]).flatMap(agentRangesOf);
  const gaps=subtract(span,covered);
  if(!gaps.length)continue;
  for(const [start,end] of gaps)intervals.push({start,end,state:'running',proof:'inferred',sourceEventIds:[counter.id],hostId:session.hostId,workspaceId:session.workspaceId,sessionId:session.sessionId,agentId:session.agentId,provider:session.provider,runId:session.runId,taskId:session.taskId,dispatchId:session.dispatchId,child:false,agentIdentity:counter.agentIdentity,attributes:counter.attributes,metadataSource:'agent-report',projectPath:counter.projectPath,attributionSource:'task-counter',attributionReason:`Agent task counter “${counter.title}”`});
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
