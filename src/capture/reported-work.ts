import type {CaptureEvent} from './events.ts';

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
