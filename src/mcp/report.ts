import type {CaptureEvent} from '../capture/events.ts';

const issuePattern=/^[A-Z][A-Z0-9]{1,15}-[1-9][0-9]{0,8}$/;
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text=(value:unknown,max:number)=>typeof value==='string'&&value.trim().length>0&&value.length<=max;

/** Only these declarations may enter the collector through its local spool. */
export function validAgentReport(event:CaptureEvent):boolean {
 if(event.source!=='agent_report'||!['work_context','task_start','task_stop','port_state'].includes(event.kind))return false;
 if(JSON.stringify(event).length>2048||Object.keys(event).some(key=>!['eventId','source','kind','observedAt','monotonicAt','collectorEpoch','provider','sessionId','workspaceId','data'].includes(key)))return false;
 if(!uuidPattern.test(event.eventId)||!text(event.data?.requestId,36)||event.eventId!==event.data?.requestId)return false;
 if(event.observedAt>Date.now()/1000+60||event.observedAt<Date.now()/1000-31*86400)return false;
 const data=event.data||{};
 const allowed=event.kind==='work_context'?['requestId','contextId','issueKey','project','task']:event.kind==='task_start'?['requestId','contextId','name','issueKey']:event.kind==='task_stop'?['requestId','contextId','taskCounterId']:['requestId','contextId','port','state','verified','processId'];
 if(Object.keys(data).some(key=>!allowed.includes(key)))return false;
 if(!text(data.contextId,36)||!uuidPattern.test(String(data.contextId)))return false;
 if(event.provider!==undefined&&!['claude','codex'].includes(event.provider))return false;
 if(event.sessionId!==undefined&&!text(event.sessionId,128))return false;
 if(event.workspaceId!==undefined&&!text(event.workspaceId,512))return false;
 if(event.kind==='work_context')return (data.issueKey===null||data.issueKey===undefined||typeof data.issueKey==='string'&&issuePattern.test(data.issueKey))&&
  (data.project===null||data.project===undefined||text(data.project,512))&&
  (data.task===null||data.task===undefined||text(data.task,180));
 if(event.kind==='task_start')return text(data.name,180)&&
  (data.issueKey===undefined||typeof data.issueKey==='string'&&issuePattern.test(data.issueKey));
 if(event.kind==='task_stop')return text(data.taskCounterId,36)&&uuidPattern.test(String(data.taskCounterId));
 return Number.isInteger(data.port)&&Number(data.port)>=1&&Number(data.port)<=65535&&
  (data.state==='open'||data.state==='closed')&&typeof data.verified==='boolean'&&
  (data.processId===null||Number.isInteger(data.processId)&&Number(data.processId)>0);
}

export {issuePattern,uuidPattern};
