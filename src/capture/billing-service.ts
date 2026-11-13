import type {BillingProgress} from './billing-progress.ts';
import {validBillingProgressId} from './billing-progress.ts';
import {PeriodTimeCredits} from '../mcp/time-credit.ts';
import {projectPathFromWorktree} from './website-resolver.ts';
import {existsSync,mkdirSync,lstatSync,writeFileSync,renameSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {openEventDatabase,isPackedEventDatabase} from './event-database.ts';
import {BillingStore,billingProjectForSource} from './billing-store.ts';
import {calculateBilling,renderBillingExport} from './billing-engine.ts';
import {billingDateRange,billingDayStart,billingLocalDate,validateBillingDate,nextBillingDate} from './billing-calendar.ts';
import {snapshot,agentFilteredIntervals,attributedIntervals,coverage,timeForProjectSet,snapshotSettings,type Snapshot} from '../mcp/data.ts';
import {agentSessionKey} from './session-identity.ts';
import type {BillingProject,BillingReport,BillingDayInput,BillingSpan} from './billing-types.ts';
import type {CaptureEvent} from './events.ts';

export interface BillingRequest {project:string;fromDate:string;toDate:string;format?:'json'|'csv'|'markdown';detail?:'summary'|'daily';reportId?:string;cursor?:string;progressId?:string;}
export type BillingPublicReport=Omit<BillingReport,'projectSnapshot'>;
export interface BillingReply {report:BillingPublicReport;nextCursor:string|null;export?:{path:string;format:string;sha256:string};}
function open(output:string,readOnly=true){const path=join(output,'events.sqlite');if(!existsSync(path))throw new Error('No captured database; open Agent Time and configure a billing project first');return openEventDatabase(path,{readOnly});}
export function validateBillingRequest(value:unknown):BillingRequest{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid billing request');const p=value as Record<string,unknown>;
 if(Object.keys(p).some(k=>!['project','fromDate','toDate','format','detail','reportId','cursor','progressId'].includes(k))||typeof p.project!=='string'||!p.project.trim()||p.project.length>4096||typeof p.fromDate!=='string'||typeof p.toDate!=='string')throw new Error('Invalid billing project or period');
 validateBillingDate(p.fromDate);validateBillingDate(p.toDate);if(p.fromDate>p.toDate)throw new Error('Invalid billing period');
 if(p.format!==undefined&&!['json','csv','markdown'].includes(String(p.format))||p.detail!==undefined&&!['summary','daily'].includes(String(p.detail))||p.reportId!==undefined&&(typeof p.reportId!=='string'||! /^[a-f0-9-]{36}$/i.test(p.reportId))||p.cursor!==undefined&&(typeof p.cursor!=='string'||! /^\d{1,7}$/.test(p.cursor)||!p.reportId))throw new Error('Invalid billing format, report ID or page cursor');
 if(p.progressId!==undefined&&!validBillingProgressId(p.progressId))throw new Error('Invalid billing progress ID');
 return p as unknown as BillingRequest;
}
export function billingProjects(output:string){
 if(!existsSync(join(output,'events.sqlite')))return {projects:[],knownSources:[]};const db=open(output);
 try{const projects=new BillingStore(db).listProjects();const known=new Set(projects.flatMap(p=>p.sources.repositories));
  for(const row of db.prepare('SELECT payload FROM events ORDER BY rowid DESC LIMIT 500').iterate()){const e=JSON.parse(String(row.payload)) as CaptureEvent;const path=e.projectPath||e.cwd||e.workspaceId?.split('::').at(-1);if(path?.startsWith('/'))known.add(path.split('/.orca/workspaces/')[0]!);}
  return {projects,knownSources:[...known].sort()};
 }finally{db.close();}
}
const sourceProject=(projects:BillingProject[],event:{workspaceId?:string;cwd?:string;projectPath?:string;project?:string|null})=>billingProjectForSource(projects,{workspaceId:event.workspaceId,path:event.projectPath||event.cwd||(event.project?.startsWith('/')?event.project:undefined)||event.workspaceId?.split('::').at(-1),reportedProject:event.project&&!event.project.startsWith('/')?event.project:undefined});
function exclusions(events:CaptureEvent[],start:number,end:number){
 // Sleep markers are retained as evidence, but are not reliable billing exclusions.
 const result:BillingDayInput['excluded']=[];let stopped:number|undefined,locked:number|undefined;
 for(const e of [...events].sort((a,b)=>a.observedAt-b.observedAt)){
  if(e.observedAt>end)break;
  if(e.kind==='capture_stop')stopped=e.observedAt;
  if(e.kind==='capture_start'&&stopped!==undefined){result.push({start:stopped,end:e.observedAt,reason:'capture paused',appliesTo:'human'});stopped=undefined;}
  if(['screen_locked','session_locked'].includes(e.kind))locked=e.observedAt;
  if(['screen_unlocked','session_unlocked'].includes(e.kind)&&locked!==undefined){result.push({start:locked,end:e.observedAt,reason:'locked'});locked=undefined;}
 }
 for(const [at,reason] of [[stopped,'capture paused'],[locked,'locked']] as const)if(at!==undefined)result.push({start:at,end,reason,...(reason==='capture paused'?{appliesTo:'human' as const}:{})});
 return result.filter(x=>x.end>start&&x.start<end).map(x=>({...x,start:Math.max(start,x.start),end:Math.min(end,x.end)}));
}
function plainDecimal(value:number):string{
 const text=String(value);if(!/[eE]/.test(text))return text;const [coefficient,exponent]=text.toLowerCase().split('e'),[integer,fraction='']=coefficient!.split('.'),digits=integer!+fraction,point=integer!.length+Number(exponent);
 return point<=0?'0.'+'0'.repeat(-point)+digits:point>=digits.length?digits+'0'.repeat(point-digits.length):digits.slice(0,point)+'.'+digits.slice(point);
}
function dayInput(output:string,db:DatabaseSync,project:BillingProject,projects:BillingProject[],date:string,settings:ReturnType<typeof snapshotSettings>,asOf:number):BillingDayInput{
 const start=billingDayStart(date,project.timezone),end=Math.min(billingDayStart(nextBillingDate(date),project.timezone),asOf);
 const data=snapshot(output,start,end,{countTaskCounters:false,billingEvidence:true,persistedOnly:true,database:db,settings});const spans:BillingSpan[]=[];
 let attributionConflict=false;
 for(const i of attributedIntervals(data)){
  if(i.state!=='human'&&i.state!=='grouped'||i.attributionSource==='task-counter'||i.userAttribution==='unassigned')continue;
  const owner=sourceProject(projects,{workspaceId:i.workspaceId,project:i.project});
  if(i.confidence==='conflict'&&i.userAttribution!=='assigned'){
   const context=data.events.filter(e=>e.source==='agent_report'&&e.kind==='work_context'&&e.provider===i.provider&&e.sessionId===i.sessionId&&e.observedAt<=i.start&&i.start-e.observedAt<=43200).sort((a,b)=>b.observedAt-a.observedAt)[0];
   const declared=typeof context?.data?.project==='string'?context.data.project:undefined;
   const reported=declared?sourceProject(projects,{project:declared}):undefined;
   // Captured path and reported name can be two aliases of the same billable project.
   if(declared&&reported?.id!==owner?.id){if(owner?.id===project.id||reported?.id===project.id)attributionConflict=true;continue;}
  }
  spans.push({start:Math.max(start,i.start),end:Math.min(end,i.end),kind:i.state==='human'?'human':'agent',sessionKey:agentSessionKey(i),projectId:owner?.id??null});
 }
 const contexts=data.events.filter(e=>e.source==='agent_report'&&e.kind==='work_context').sort((a,b)=>a.observedAt-b.observedAt);
 const humanMessages=data.events.filter(e=>e.source==='hook'&&e.kind==='prompt_submitted'&&e.observedAt>=start-86400).filter(e=>e.data?.humanInitiated===true||Boolean(e.terminalHandle)&&spans.some(s=>s.kind==='human'&&s.projectId===project.id&&s.start<=e.observedAt+15&&s.end>=e.observedAt-15)).filter(e=>{
  if(sourceProject(projects,{workspaceId:e.workspaceId,cwd:e.cwd,projectPath:e.projectPath})?.id===project.id)return true;
  const context=contexts.findLast(c=>c.provider===e.provider&&c.sessionId===e.sessionId&&c.observedAt<=e.observedAt);
  return context&&sourceProject(projects,{workspaceId:context.workspaceId,project:typeof context.data?.project==='string'?context.data.project:undefined})?.id===project.id;
 }).map(e=>e.observedAt);
 const usage:BillingDayInput['usage']=[];
 for(const e of data.events)if(e.source==='agent_report'&&e.kind==='task_stop'&&e.observedAt>=start&&e.observedAt<end){
  const id=String(e.data?.taskCounterId||'');const row=db.prepare('SELECT payload FROM events WHERE event_id=?').get(id);const task=row?JSON.parse(String(row.payload)) as CaptureEvent:data.events.find(item=>item.eventId===id);
  const owner=task&&sourceProject(projects,{workspaceId:task.workspaceId,project:typeof task.data?.project==='string'?task.data.project:undefined});if(owner?.id!==project.id)continue;
  const u=e.data?.usage as Record<string,unknown>|undefined;usage.push({id,taskCounterId:id,at:e.observedAt,cost:typeof u?.cost==='number'&&Number.isFinite(u.cost)&&u.cost>=0?plainDecimal(u.cost):null,currency:typeof u?.currency==='string'?u.currency:undefined,source:String(u?.source||'agent-report'),verified:false,projectId:owner.id});
 }
 // Metadata-only sample bounds avoid decoding a day of unrelated foreground payloads.
 const sampleQuery=isPackedEventDatabase(db)?'SELECT observed_at FROM events WHERE observed_at>=? AND observed_at<? AND activity_sample=1 ORDER BY observed_at':"SELECT observed_at FROM events WHERE observed_at>=? AND observed_at<? AND json_extract(payload,'$.source')='macos' AND json_extract(payload,'$.kind')='activity' ORDER BY observed_at";
 let first:number|undefined,last:number|undefined;const observationGaps:BillingDayInput['excluded']=[];
 for(const row of db.prepare(sampleQuery).iterate(start,end)){const at=Number(row.observed_at);first??=at;if(last!==undefined&&at-last>300)observationGaps.push({start:last,end:at,reason:'No macOS observations; unverified capture gap'});last=at;}
 // Missing Mac samples are expected while human capture is deliberately paused.
 // Keep the full gap for human coverage, but do not re-exclude native agent work
 // inside an explicit pause. Unexplained parts of the gap still exclude both.
 const knownExclusions=exclusions(data.events,start,end);
 const pauses=knownExclusions.filter(c=>c.appliesTo==='human').sort((a,b)=>a.start-b.start);
 const scopedGaps=observationGaps.flatMap(gap=>{
  const parts:BillingDayInput['excluded']=[];let cursor=gap.start;
  for(const pause of pauses){
   if(pause.end<=cursor)continue;if(pause.start>=gap.end)break;
   if(pause.start>cursor)parts.push({...gap,start:cursor,end:pause.start});
   const end=Math.min(gap.end,pause.end);
   parts.push({...gap,start:Math.max(cursor,pause.start),end,appliesTo:'human'});cursor=end;
  }
  if(cursor<gap.end)parts.push({...gap,start:cursor});return parts;
 });
 const samples={first,last};
 const evidenceCoverage=coverage(data);const covered=typeof samples?.first==='number'&&typeof samples?.last==='number'&&Number(samples.first)<=start+300&&Number(samples.last)>=end-300&&!evidenceCoverage.issues.length&&!evidenceCoverage.permissionPeriods.length&&!observationGaps.length&&!attributionConflict;
 return {date,start,end,spans,excluded:[...knownExclusions,...scopedGaps],humanMessages,presenceEvidenceAvailable:humanMessages.length>0,usage,usageComplete:false,coverageComplete:covered};
}
function reply(report:BillingReport,request:BillingRequest,output:string):BillingReply{
 const offset=Number(request.cursor||0);if(offset>report.days.length)throw new Error('Invalid billing cursor');
 const {projectSnapshot,...publicReport}=report;const daily=request.detail==='daily';const days=daily?report.days.slice(offset,offset+31):[];
 const response:BillingReply={report:{...publicReport,days},nextCursor:daily&&offset+31<report.days.length?String(offset+31):null};
 if(request.format&&request.format!=='json'){
  const directory=join(output,'billing-exports');if(existsSync(directory)&&lstatSync(directory).isSymbolicLink())throw new Error('Invalid billing export directory');mkdirSync(directory,{recursive:true,mode:0o700});
  const text=renderBillingExport(report,request.format),extension=request.format==='csv'?'csv':'md',path=join(directory,`${report.reportId}.${extension}`);if(existsSync(path)){const info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink())throw new Error('Invalid billing export file');}
  const temporary=join(directory,`${randomUUID()}.tmp`);
  try{writeFileSync(temporary,text,{mode:0o600,flag:'wx'});renameSync(temporary,path);}finally{rmSync(temporary,{force:true});}response.export={path,format:request.format,sha256:createHash('sha256').update(text).digest('hex')};
 }
 return response;
}
export function billingForProject(output:string,value:BillingRequest,onProgress?:(progress:BillingProgress)=>void):BillingReply{
 const request=validateBillingRequest(value),db=open(output,false);
 try{
  const store=new BillingStore(db),project=store.resolveProject(request.project);
  if(request.reportId){const report=store.report(request.reportId);if(!report||report.projectId!==project.id||report.fromDate!==request.fromDate||report.toDate!==request.toDate)throw new Error('Saved billing report does not match the requested project or period');return reply(report,request,output);}
  if(request.toDate>billingLocalDate(Date.now()/1000,project.timezone))throw new Error('Future billing dates are unavailable');
  const settings=snapshotSettings(output),asOf=Date.now()/1000;
  // A read transaction pins events and review decisions while capture keeps writing through WAL.
  db.exec('BEGIN');let report:BillingReport;
  try{const projects=store.listProjects();const frozenProject=store.resolveProject(project.id);
   const totalDays=(Date.parse(request.toDate+'T00:00:00Z')-Date.parse(request.fromDate+'T00:00:00Z'))/86400000+1;let completedDays=0;
   function* inputs(){for(const date of billingDateRange(request.fromDate,request.toDate)){
    onProgress?.({phase:'reading',completedDays,totalDays,date});
    yield dayInput(output,db,frozenProject,projects,date,settings,asOf);
    onProgress?.({phase:'calculating',completedDays:++completedDays,totalDays,date});
   }}
   report=calculateBilling(frozenProject,inputs(),{fromDate:request.fromDate,toDate:request.toDate});
   const input={eventRowid:db.prepare('SELECT coalesce(max(rowid),0) n FROM events').get()?.n,settings,projectRevision:frozenProject.revision};
   const revisionHash=createHash('sha256').update(JSON.stringify(input));
   for(const table of ['human_decisions','human_splits'])for(const row of db.prepare(`SELECT * FROM ${table} ORDER BY start_event_id,end_event_id`).iterate())revisionHash.update(JSON.stringify(row));
   report.inputRevision=revisionHash.digest('hex');db.exec('COMMIT');
   onProgress?.({phase:'saving',completedDays,totalDays});
  }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
  const {reportId:_id,createdAt:_at,inputRevision:_revision,...content}=report;
  const contentHash=createHash('sha256').update(JSON.stringify(content)).digest('hex');
  report.reportId=`${contentHash.slice(0,8)}-${contentHash.slice(8,12)}-5${contentHash.slice(13,16)}-a${contentHash.slice(17,20)}-${contentHash.slice(20,32)}`;
  const existing=store.report(report.reportId);if(existing)return reply(existing,request,output);
  store.saveReport(report);return reply(report,request,output);
 }finally{db.close();}
}

/** Existing measured metrics keep their minute-credit semantics; this compact reader never accumulates raw days. */
export function projectTimeForRange(output:string,request:{project:string;fromDate:string;toDate:string;view?:'summary'|'details';agentIdentityId?:string;agentProfile?:string}){
 validateBillingDate(request.fromDate);validateBillingDate(request.toDate);if(request.fromDate>request.toDate)throw new Error('Invalid time period');
 const db=open(output);let projects:BillingProject[],configured:BillingProject|undefined;
 try{projects=new BillingStore(db).listProjects();try{configured=new BillingStore(db).resolveProject(request.project);}catch(error){if(String(error).toLowerCase().includes('ambiguous')||projects.some(p=>p.id===request.project||p.aliases.includes(request.project)||p.name===request.project))throw error;}}
 finally{db.close();}
 if(request.toDate>billingLocalDate(Date.now()/1000,configured?.timezone||Intl.DateTimeFormat().resolvedOptions().timeZone))throw new Error('Future time dates are unavailable');
 const suffix=request.project.split('::').at(-1)!,nativeProject=suffix.startsWith('/')?projectPathFromWorktree(suffix):request.project;
 const contextSlices:unknown[]=[];let moreContextSlices=false;
 const timezone=configured?.timezone||Intl.DateTimeFormat().resolvedOptions().timeZone,days:Array<Record<string,unknown>>=[];
 const periodCredit=new PeriodTimeCredits(),issueCredits=new Map<string,PeriodTimeCredits>();let known=Boolean(configured),truncatedBefore=false;let issueCount=0,coverageIssueCount=0,dayCount=0;const issuesByKey=new Map<string,ReturnType<PeriodTimeCredits['totals']>&{issueKey:string}>();const captureCoverage={issues:[] as unknown[],gaps:[] as unknown[],permissionPeriods:[] as unknown[],moreIssues:false,morePermissionPeriods:false,truncatedBefore:false};
 for(const date of billingDateRange(request.fromDate,request.toDate)){
  const start=billingDayStart(date,timezone),end=billingDayStart(nextBillingDate(date),timezone),s=snapshot(output,start,end);
  const rows=attributedIntervals(s);const paths=configured?[...new Set(rows.filter(i=>sourceProject(projects,{workspaceId:i.workspaceId,project:i.project})?.id===configured!.id).flatMap(i=>i.project?[i.project]:[]))]:[nativeProject];
  if(!configured&&rows.some(i=>i.project===nativeProject))known=true;
  const item=timeForProjectSet(s,paths,configured?.id||nativeProject,request),base=rows.filter(i=>i.project!==null&&paths.includes(i.project)),selected=agentFilteredIntervals(s,base,request);periodCredit.add(selected,end,base);
  if(item.moreContextSlices||item.contextSlices.length>500-contextSlices.length)moreContextSlices=true;contextSlices.push(...item.contextSlices.slice(0,500-contextSlices.length));
  coverageIssueCount+=item.captureCoverage.issues.length;issueCount+=item.issues.length;truncatedBefore ||=item.truncatedBefore;
  if(request.view!=='summary'){
   const byIssue=new Map<string,typeof selected>();for(const row of selected){const key=row.issueKey||'Unmatched',group=byIssue.get(key)||[];group.push(row);byIssue.set(key,group);}
   for(const key of byIssue.keys())if(!issueCredits.has(key)&&issueCredits.size<500)issueCredits.set(key,new PeriodTimeCredits());
   for(const [key,credit] of issueCredits){credit.add(byIssue.get(key)||[],end,base.filter(row=>(row.issueKey||'Unmatched')===key));issuesByKey.set(key,{issueKey:key,...credit.totals()});}
   for(const key of ['issues','gaps','permissionPeriods'] as const){captureCoverage[key].push(...item.captureCoverage[key].slice(0,500-captureCoverage[key].length));}
   captureCoverage.moreIssues ||=item.captureCoverage.moreIssues||coverageIssueCount>500;captureCoverage.morePermissionPeriods ||=item.captureCoverage.morePermissionPeriods;captureCoverage.truncatedBefore ||=item.captureCoverage.truncatedBefore;
  }
  dayCount++;if(days.length<31)days.push({date,humanActiveSeconds:item.humanActiveSeconds,agentRunningSeconds:item.agentRunningSeconds,agentWallSeconds:item.agentWallSeconds,overlapMergedWallSeconds:item.overlapMergedWallSeconds,...(request.view==='details'?{issues:item.issues,captureCoverage:item.captureCoverage}:{})});
 }
 if(!known)throw new Error('Unknown project; use billing_projects to select a configured project or an exact captured path');
 const totals=periodCredit.totals();
 return {project:configured?.id||nativeProject,...totals,contextSlices,moreContextSlices,hours:{humanActive:(totals.humanActiveSeconds/3600).toFixed(2),agentRunning:(totals.agentRunningSeconds/3600).toFixed(2),agentWall:(totals.agentWallSeconds/3600).toFixed(2),overlapMergedWall:(totals.overlapMergedWallSeconds/3600).toFixed(2)},...(request.view!=='summary'?{issues:[...issuesByKey.keys()].sort().map(key=>issuesByKey.get(key)!).map(i=>({...i,hours:{humanActive:(Number(i.humanActiveSeconds)/3600).toFixed(2),agentRunning:(Number(i.agentRunningSeconds)/3600).toFixed(2),agentWall:(Number(i.agentWallSeconds)/3600).toFixed(2),overlapMergedWall:(Number(i.overlapMergedWallSeconds)/3600).toFixed(2)}})),captureCoverage}:{}),days:request.view==='summary'?days.slice(0,31):days,coverageIssueCount,issueCount,truncatedBefore,aggregation:'minute-credit-per-contiguous-period-block',moreDays:dayCount>31};
}
