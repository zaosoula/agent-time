import {randomUUID} from 'node:crypto';
import {McpServer} from '@modelcontextprotocol/server';
import {serveStdio} from '@modelcontextprotocol/server/stdio';
import {z} from 'zod';
import {coverageForRange,currentWork,defaultDataDirectory,explainAttribution,inferRecentSession,range,readReport,sessions,snapshot,timeForIssue,timeForProject,timeline,unattributed,verifyPort,writeReport} from './data.ts';

const output=defaultDataDirectory(),contextId=randomUUID();
const result=(value:unknown)=>({content:[{type:'text' as const,text:JSON.stringify(value)}]});
const dates={fromDate:z.string().describe('First local date, YYYY-MM-DD'),toDate:z.string().describe('Last local date, YYYY-MM-DD, inclusive')};
const identity={provider:z.enum(['claude','codex']).optional(),sessionId:z.string().min(1).max(128).optional(),workspaceId:z.string().min(1).max(512).optional()};
const requestId=z.uuid().optional().describe('Stable UUID for retry safety; reuse it when retrying the same declaration');
const issueKey=z.string().regex(/^[A-Z][A-Z0-9]{1,15}-[1-9][0-9]{0,8}$/);
const snap=(fromDate:string,toDate:string)=>{const bounds=range(fromDate,toDate);return snapshot(output,bounds.from,bounds.to);};
const report=(kind:'work_context'|'task_start'|'task_stop'|'port_state',id:string|undefined,data:Record<string,unknown>,who:{provider?:string;sessionId?:string;workspaceId?:string})=>{
 const provider=who.provider||process.env.AGENT_TIME_PROVIDER,workspaceId=who.workspaceId||process.env.ORCA_WORKTREE_ID||process.env.ORCA_WORKSPACE_ID;
 return writeReport(output,kind,id||randomUUID(),contextId,data,{provider,workspaceId,sessionId:who.sessionId||provider&&inferRecentSession(output,provider,workspaceId)||undefined});
};

export function createServer(){
 const server=new McpServer({name:'agent-time',version:'0.2.0'});
 server.registerTool('time_for_issue',{description:'Measured local time linked to a reported Linear issue, with evidence and overlap-aware totals. Reported context is advisory, not billing approval.',inputSchema:z.object({...dates,issueKey})},({fromDate,toDate,issueKey})=>result(timeForIssue(snap(fromDate,toDate),issueKey)));
 server.registerTool('time_for_project',{description:'Measured local time for a tracked project, grouped by reported issue and unmatched time.',inputSchema:z.object({...dates,project:z.string().min(1).max(512)})},({fromDate,toDate,project})=>result(timeForProject(snap(fromDate,toDate),project)));
 server.registerTool('timeline',{description:'Observed human and agent intervals with source event IDs and attribution confidence.',inputSchema:z.object({...dates,project:z.string().min(1).max(512).optional()})},({fromDate,toDate,project})=>result(timeline(snap(fromDate,toDate),project)));
 server.registerTool('sessions',{description:'Captured agent sessions filtered by provider, workspace, or reported issue.',inputSchema:z.object({...dates,provider:z.enum(['claude','codex']).optional(),workspace:z.string().min(1).max(512).optional(),issueKey:issueKey.optional()})},({fromDate,toDate,...filter})=>result(sessions(snap(fromDate,toDate),filter)));
 server.registerTool('coverage',{description:'Capture notices, missing Accessibility permission and macOS observation gaps. An observation gap is not automatically idle time.',inputSchema:z.object(dates)},({fromDate,toDate})=>{const bounds=range(fromDate,toDate);return result(coverageForRange(output,bounds.from,bounds.to));});
 server.registerTool('unattributed',{description:'Human activity groups needing a project decision. URLs and raw event payloads are omitted.',inputSchema:z.object(dates)},({fromDate,toDate})=>result(unattributed(snap(fromDate,toDate))));
 server.registerTool('explain_attribution',{description:'Explain the source events and confidence for a captured interval.',inputSchema:z.object({...dates,eventId:z.uuid()})},({fromDate,toDate,eventId})=>result(explainAttribution(snap(fromDate,toDate),eventId)));
 server.registerTool('current_work',{description:'Recent agent-reported context, open task counters and port claims. Elapsed counters are not measured time.',inputSchema:z.object({})},()=>result({contextId,...currentWork(output)}));
 server.registerTool('set_work_context',{description:'Report the current task, optional Linear issue and project. This does not change measured or billable time. Supply your hook session ID when available for a reliable interval link.',inputSchema:z.object({...identity,requestId,issueKey:issueKey.nullable().optional(),project:z.string().min(1).max(512).nullable().optional(),task:z.string().min(1).max(180).nullable().optional()})},({requestId,provider,sessionId,workspaceId,issueKey,project,task})=>result(report('work_context',requestId,{issueKey:issueKey??null,project:project??null,task:task??null},{provider,sessionId,workspaceId})));
 server.registerTool('start_task',{description:'Start a named agent-reported elapsed counter. Returns a taskCounterId; this does not credit tracked time.',inputSchema:z.object({...identity,requestId,name:z.string().min(1).max(180),issueKey:issueKey.optional()})},({requestId,provider,sessionId,workspaceId,name,issueKey})=>{const e=report('task_start',requestId,{name,issueKey},{provider,sessionId,workspaceId});return result({taskCounterId:e.eventId,startedAt:e.observedAt,measured:false});});
 server.registerTool('stop_task',{description:'Stop a named elapsed counter by its server-issued taskCounterId. The reported duration is separate from observed time.',inputSchema:z.object({...identity,requestId,taskCounterId:z.uuid()})},({requestId,provider,sessionId,workspaceId,taskCounterId})=>{const start=readReport(output,taskCounterId);if(!start||start.kind!=='task_start')throw new Error('Unknown task counter');const e=report('task_stop',requestId,{taskCounterId},{provider,sessionId,workspaceId});return result({taskCounterId,stoppedAt:e.observedAt,reportedElapsedSeconds:Math.max(0,Math.round(e.observedAt-start.observedAt)),measured:false});});
 server.registerTool('report_port_state',{description:'Report a local TCP port opening or closing. The server checks the listener; a running listener is not proof of active work.',inputSchema:z.object({...identity,requestId,port:z.number().int().min(1).max(65535),state:z.enum(['open','closed'])})},({requestId,provider,sessionId,workspaceId,port,state})=>{const observed=verifyPort(port),verified=observed.verified&&(state==='open'?observed.processId!==null:observed.processId===null);const e=report('port_state',requestId,{port,state,verified,processId:observed.processId},{provider,sessionId,workspaceId});return result({eventId:e.eventId,port,claimedState:state,observedState:observed.verified?(observed.processId?'open':'closed'):'unknown',verified});});
 return server;
}

if(import.meta.main)void serveStdio(createServer);
