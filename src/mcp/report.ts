import {MAX_AGENT_REPORT_BYTES,validateAttributes,validateAgentIdentity} from '../capture/work-context.ts';
import type {CaptureEvent} from '../capture/events.ts';
import {resourceKey,resourceKinds} from '../capture/reported-resources.ts';

const issuePattern=/^[A-Z][A-Z0-9]{1,15}-[1-9][0-9]{0,8}$/;
// Free references are accepted only when explicitly declared; page extraction stays Linear-shaped.
const ticketPattern=/^[^\x00-\x1f\x7f]{1,128}$/;
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text=(value:unknown,max:number)=>typeof value==='string'&&value.trim().length>0&&value.length<=max;

/** Only these declarations may enter the collector through its local spool. */
export function validAgentReport(event:CaptureEvent):boolean {
 if(event.source!=='agent_report'||!['work_context','task_start','task_stop','task_heartbeat','port_state','resource'].includes(event.kind))return false;
 if(Buffer.byteLength(JSON.stringify(event))>MAX_AGENT_REPORT_BYTES||Object.keys(event).some(key=>!['eventId','source','kind','observedAt','monotonicAt','collectorEpoch','provider','sessionId','workspaceId','hostId','data'].includes(key)))return false;
 if(!uuidPattern.test(event.eventId)||!text(event.data?.requestId,36)||event.eventId!==event.data?.requestId)return false;
 if(event.observedAt>Date.now()/1000+60||event.observedAt<Date.now()/1000-31*86400)return false;
 const data=event.data||{};
 const allowed=event.kind==='work_context'?['requestId','contextId','issueKey','project','task','agentIdentity','attributes','billable']:event.kind==='task_start'?['requestId','contextId','name','issueKey','project','agentIdentity','attributes','parentTaskCounterId','billable','leaseSeconds']:event.kind==='task_stop'?['requestId','contextId','taskCounterId','usage','outcome']:event.kind==='task_heartbeat'?['requestId','contextId','taskCounterId']:event.kind==='resource'?['requestId','contextId','url','title','resourceKind','project']:['requestId','contextId','port','state','verified','processId'];
 if(Object.keys(data).some(key=>!allowed.includes(key)))return false;
 if(!text(data.contextId,36)||!uuidPattern.test(String(data.contextId)))return false;
 if(event.provider!==undefined&&!['claude','codex'].includes(event.provider))return false;
 if(event.sessionId!==undefined&&!text(event.sessionId,128))return false;
 if(event.hostId!==undefined&&!text(event.hostId,128))return false;
 if(event.workspaceId!==undefined&&!text(event.workspaceId,512))return false;
 if(data.agentIdentity!==undefined)try{validateAgentIdentity(data.agentIdentity);}catch{return false;}
 if(data.attributes!==undefined)try{validateAttributes(data.attributes);}catch{return false;}
 if(data.billable!==undefined&&data.billable!==null&&typeof data.billable!=='boolean')return false;
 if(data.project!==undefined&&data.project!==null&&!text(data.project,512))return false;
 if(data.parentTaskCounterId!==undefined&&!uuidPattern.test(String(data.parentTaskCounterId)))return false;
 if(data.leaseSeconds!==undefined&&(!Number.isInteger(data.leaseSeconds)||Number(data.leaseSeconds)<60||Number(data.leaseSeconds)>43200))return false;
 if(data.usage!==undefined){
  const u=data.usage as Record<string,unknown>;
  if(!u||typeof u!=='object'||Array.isArray(u)||Object.keys(u).some(k=>!['inputTokens','outputTokens','cachedInputTokens','cost','currency','source'].includes(k))||!['agent-reported','provider-response'].includes(String(u.source)))return false;
  for(const key of ['inputTokens','outputTokens','cachedInputTokens'])if(u[key]!==undefined&&(!Number.isSafeInteger(u[key])||Number(u[key])<0))return false;
  if(u.cost!==undefined&&(typeof u.cost!=='number'||!Number.isFinite(u.cost)||u.cost<0||typeof u.currency!=='string'||! /^[A-Z]{3}$/.test(u.currency)))return false;
  if(u.currency!==undefined&&(typeof u.currency!=='string'||! /^[A-Z]{3}$/.test(u.currency)))return false;
 }
 if(data.outcome!==undefined&&!['completed','failed','cancelled'].includes(String(data.outcome)))return false;
 if(event.kind==='work_context')return (data.issueKey===null||data.issueKey===undefined||typeof data.issueKey==='string'&&ticketPattern.test(data.issueKey)&&text(data.issueKey,128))&&
  (data.project===null||data.project===undefined||text(data.project,512))&&
  (data.task===null||data.task===undefined||text(data.task,180));
 if(event.kind==='task_start')return text(data.name,180)&&
  (data.issueKey===undefined||typeof data.issueKey==='string'&&ticketPattern.test(data.issueKey)&&text(data.issueKey,128));
 if(event.kind==='task_stop'||event.kind==='task_heartbeat')return text(data.taskCounterId,36)&&uuidPattern.test(String(data.taskCounterId));
 if(event.kind==='resource'){
  let url:URL|null=null;try{url=typeof data.url==='string'&&data.url.length<=1024?new URL(data.url):null;}catch{/* Invalid URL. */}
  return Boolean(url&&!url.username&&!url.password&&resourceKey(url.href))&&
   (data.title===undefined||text(data.title,180))&&
   (data.resourceKind===undefined||(resourceKinds as readonly unknown[]).includes(data.resourceKind))&&
   (data.project===undefined||text(data.project,512));
 }
 return Number.isInteger(data.port)&&Number(data.port)>=1&&Number(data.port)<=65535&&
  (data.state==='open'||data.state==='closed')&&typeof data.verified==='boolean'&&
  (data.processId===null||Number.isInteger(data.processId)&&Number(data.processId)>0);
}

export {issuePattern,ticketPattern,uuidPattern};
