import {boundedSpoolListing,MAX_PENDING_HOOKS,MAX_HOOK_BYTES} from '../capture/hooks.ts';
import {openEventDatabase,isPackedEventDatabase} from '../capture/event-database.ts';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {existsSync,linkSync,lstatSync,mkdirSync,readFileSync,readdirSync,unlinkSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {basename,isAbsolute,join} from 'node:path';
import {homedir} from 'node:os';
import {makeEvent,type CaptureEvent,type Interval,type Issue,type Session,type Summary} from '../capture/events.ts';
import {readWindowEvents} from '../capture/summary-window.ts';
import {minuteCreditSeconds,summarize} from '../capture/correlate.ts';
import {agentSessionKey} from '../capture/session-identity.ts';
import {applyHumanDecisions,groupHumanReview,humanReviewState,type HumanDecision,type HumanSplit} from '../capture/human-review.ts';
import {unobservedGaps} from '../capture/gaps.ts';
import {projectPathFromWorktree} from '../capture/website-resolver.ts';
import {creditTaskCounters,reportedWorkForDay,hydrateTaskStarts} from '../capture/reported-work.ts';
import {applyReportedResources,reportedResources} from '../capture/reported-resources.ts';
import {issuePattern,ticketPattern,uuidPattern,validAgentReport} from './report.ts';

export const defaultDataDirectory=()=>process.env.ADE_CAPTURE_OUTPUT||join(homedir(),'Library','Application Support','studio.ezyo.agenttime');
const now=()=>Date.now()/1000;
const dateOf=(seconds:number)=>{const d=new Date(seconds*1000);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
function dateStart(date:string):number{
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new Error('Use a YYYY-MM-DD local date');
 const d=new Date(`${date}T00:00:00`);
 if(Number.isNaN(d.getTime())||dateOf(d.getTime()/1000)!==date)throw new Error('Invalid local date');
 return d.getTime()/1000;
}
export function range(fromDate:string,toDate:string){
 const from=dateStart(fromDate),end=new Date(dateStart(toDate)*1000);end.setDate(end.getDate()+1);
 const to=end.getTime()/1000;
 const calendarDays=(Date.parse(`${toDate}T00:00:00Z`)-Date.parse(`${fromDate}T00:00:00Z`))/86400000+1;
 if(to<=from||calendarDays>30)throw new Error('Date range must cover 1 to 30 local days');
 if(to>now()+86400)throw new Error('Future range is not available');
 return {from,to};
}
function database(output:string,readOnly=true):DatabaseSync{
 const path=join(output,'events.sqlite');if(!existsSync(path))throw new Error('Agent Time has no captured data yet');
 return openEventDatabase(path,{readOnly});
}
// Reuse existing collector indexes; legacy read-only archives may not have them.
const reportIndex=(db:DatabaseSync)=>db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='events_reports_at'").get()?'INDEXED BY events_reports_at':'';
const endIndex=(db:DatabaseSync)=>db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='events_session_ends_at'").get()?'INDEXED BY events_session_ends_at':'';
function hydrateReports(db:DatabaseSync|null,events:CaptureEvent[]){
 const read=db?.prepare('SELECT payload FROM events WHERE event_id=?');
 return hydrateTaskStarts(events,id=>{const row=read?.get(id);return row?JSON.parse(String(row.payload)) as CaptureEvent:undefined;});
}
function pendingReports(output:string):CaptureEvent[]{
 const events:CaptureEvent[]=[],spool=join(output,'spool');
 if(!existsSync(spool))return events;
 for(const name of boundedSpoolListing(spool).files.filter(name=>name.endsWith('.json')).slice(0,2000))try{
  const path=join(spool,name),info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink()||info.size>2048)continue;
  const event=JSON.parse(readFileSync(path,'utf8')) as CaptureEvent;if(validAgentReport(event))events.push(event);
 }catch{/* Ignore incomplete or invalid spool entries. */}
 return events;
}
export interface Snapshot {summary:Summary;events:CaptureEvent[];from:number;to:number;truncatedBefore:boolean;firstSeen?:Map<string,number>;}
// A safety cap on one day's window, far above a day of two-second samples.
const maxWindowEvents=1_500_000;
export function snapshotSettings(output:string){
 const settingsPath=join(output,'settings.json');let settings:Record<string,unknown>={};
 if(existsSync(settingsPath))try{settings=JSON.parse(readFileSync(settingsPath,'utf8'));}catch{/* Use collector defaults for invalid settings. */}
 const idle=Number(settings.humanIdleMinutes),agentIdle=Number(settings.agentIdleMinutes);
 return {idleThreshold:Number.isFinite(idle)&&idle>0?idle*60:300,agentIdleThreshold:Number.isFinite(agentIdle)&&agentIdle>0?agentIdle*60:300,countTaskCounters:settings.countTaskCounters===true};
}
/** Split a range into pieces of at most one day, so each summary reads a bounded window. */
function chunks(from:number,to:number):Array<[number,number]>{
 const result:Array<[number,number]>=[];
 for(let start=from;start<to;){
  const next=new Date(start*1000);next.setHours(24,0,0,0);
  const end=Math.min(to,Math.max(next.getTime()/1000,start+1));
  result.push([start,end]);start=end;
 }
 return result;
}
/**
 * Summarize [from,to) one local day at a time. Each day reads agent evidence
 * from a day plus the agent idle threshold before and after it (long turns and
 * sessions keep their start and end), but Mac activity only around the day, so
 * memory stays near one day of samples and 30-day ranges work.
 */
export function snapshot(output:string,from:number,to:number,readOptions:{countTaskCounters?:boolean;billingEvidence?:boolean;persistedOnly?:boolean;database?:DatabaseSync;settings?:ReturnType<typeof snapshotSettings>}={}):Snapshot{
 if(!Number.isFinite(from)||!Number.isFinite(to)||to<=from||to-from>31*86400)throw new Error('Invalid bounded time range');
 const db=readOptions.database||database(output);
 try{
  const decisions=db.prepare('SELECT start_event_id,end_event_id,mode,project_path FROM human_decisions').all().map(row=>({startEventId:String(row.start_event_id),endEventId:String(row.end_event_id),mode:row.mode,projectPath:row.project_path===null?null:String(row.project_path)})) as HumanDecision[];
  const splits=db.prepare('SELECT start_event_id,end_event_id,split_at,before_path,after_path FROM human_splits').all().map(row=>({startEventId:String(row.start_event_id),endEventId:String(row.end_event_id),splitAt:Number(row.split_at),beforePath:row.before_path===null?null:String(row.before_path),afterPath:row.after_path===null?null:String(row.after_path)})) as HumanSplit[];
  const options={...(readOptions.settings||snapshotSettings(output)),...(readOptions.countTaskCounters!==undefined?{countTaskCounters:readOptions.countTaskCounters}:{})},pending=readOptions.persistedOnly?[]:pendingReports(output);
  const resourceFrom=readOptions.billingEvidence?from-31*86400:now()-31*86400,resourceTo=readOptions.billingEvidence?to+31*86400:Infinity;
  const resourceRows=db.prepare(`SELECT payload FROM events ${isPackedEventDatabase(db)?'INDEXED BY events_resources_at':''} WHERE observed_at>? AND observed_at<? AND json_extract(payload,'$.source')='agent_report' AND json_extract(payload,'$.kind')='resource' LIMIT 20001`).all(resourceFrom,resourceTo);
  if(resourceRows.length>20000)throw new Error('Too many resource mappings for a bounded summary; use explicit project attribution');
  const resources=reportedResources([...resourceRows.map(row=>JSON.parse(String(row.payload)) as CaptureEvent),...pending]);
  const intervals:Interval[]=[],coverage:Issue[]=[],unresolved:Issue[]=[],sessions=new Map<string,Session>(),firstSeen=new Map<string,number>();
  const kept=new Map<string,CaptureEvent>();let previousTrusted=true;let readFrom=Infinity;
  for(const [start,end] of chunks(from,to)){
   const window=readWindowEvents(db,start,end,options.agentIdleThreshold);
   if(window.events.length>maxWindowEvents)throw new Error('Too many events for one day; use a shorter date range');
   readFrom=Math.min(readFrom,window.bounds.readFrom);
   const rawEvents=[...window.events,...pending.filter(e=>e.observedAt>=window.bounds.readFrom&&e.observedAt<window.bounds.readTo)];
   const events=options.countTaskCounters?hydrateReports(db,rawEvents):rawEvents;
   const decided=applyReportedResources(applyHumanDecisions(summarize(events,options),decisions,splits),resources);
   const summary=options.countTaskCounters?creditTaskCounters(decided,reportedWorkForDay(events,start,end,now())):decided;
   const underlying=new Map<string,Interval[]>(),sessionPaths=new Map<string,string>();
   for(const source of summary.intervals)if(source.state!=='grouped'&&source.state!=='human'&&source.sessionId){const key=`${source.provider}:${source.sessionId}`;const group=underlying.get(key)||[];group.push(source);underlying.set(key,group);}
   for(const session of summary.sessions)if(session.cwd&&session.sessionId)sessionPaths.set(`${session.provider}:${session.sessionId}`,session.cwd);
   const clipped=summary.intervals.filter(i=>i.end>start&&i.start<end).map(i=>({...i,start:Math.max(start,i.start),end:Math.min(end,i.end)}));
   for(const interval of clipped)if(interval.state==='grouped'&&!interval.sourceEventIds.length){
    interval.sourceEventIds=[...new Set((underlying.get(`${interval.provider}:${interval.sessionId}`)||[]).filter(source=>source.end>interval.start&&source.start<interval.end).flatMap(source=>source.sourceEventIds))].slice(0,32);
   }
   for(const interval of clipped)if(!interval.workspaceId&&interval.sessionId){
    const cwd=sessionPaths.get(`${interval.provider}:${interval.sessionId}`);
    if(cwd)interval.workspaceId=`session::${projectPathFromWorktree(cwd)}`;
   }
   intervals.push(...clipped);
   const inChunk=(issue:Issue)=>issue.observedAt===undefined?start===from:issue.observedAt>=start&&issue.observedAt<end;
   coverage.push(...summary.coverage.filter(inChunk));unresolved.push(...summary.unresolved.filter(inChunk));
   for(const session of summary.sessions){const previous=sessions.get(session.key);if(!previous||session.lastObservedAt>=previous.lastObservedAt)sessions.set(session.key,session);}
   // Keep only the evidence the attribution and coverage views read.
   const creditedCounters=new Set(summary.intervals.filter(i=>i.attributionSource==='task-counter').flatMap(i=>i.sourceEventIds));
   for(const event of events){
    if(event.provider&&event.sessionId){const key=`${event.provider}:${event.sessionId}`;firstSeen.set(key,Math.min(firstSeen.get(key)??Infinity,event.observedAt));}
    // Reported context keeps its earlier reach: an hour before the range.
    if(readOptions.billingEvidence&&(event.source==='capture'||['sleep','wake','screen_locked','screen_unlocked','session_locked','session_unlocked'].includes(event.kind)||event.source==='hook'&&event.kind==='prompt_submitted')){kept.set(event.eventId,event);continue;}
    if(event.source==='agent_report'){if((event.observedAt>=from-3600||creditedCounters.has(event.eventId))&&event.observedAt<to)kept.set(`${event.eventId}|${event.observedAt}`,event);continue;}
    if(event.source!=='macos'||event.kind!=='activity'||event.observedAt<start||event.observedAt>=end)continue;
    const untrusted=event.data?.accessibilityTrusted===false;
    if(untrusted||!previousTrusted||hasIssueKeys(event))kept.set(event.eventId,event);
    previousTrusted=!untrusted;
   }
  }
  const measured=totals(intervals),children=intervals.filter(i=>i.child&&i.state==='grouped'),byChild=new Map<string,Array<[number,number]>>();
  for(const i of children){const key=agentSessionKey(i),group=byChild.get(key)||[];group.push([i.start,i.end]);byChild.set(key,group);}
  const summary:Summary={intervals,coverage,unresolved,sessions:[...sessions.values()],humanSeconds:measured.humanActiveSeconds,agentSeconds:measured.agentRunningSeconds,agentWallSeconds:measured.agentWallSeconds,childAgentSeconds:[...byChild.values()].reduce((sum,group)=>sum+minuteCreditSeconds(group),0),elapsedSeconds:measured.overlapMergedWallSeconds};
  const truncatedBefore=Boolean(db.prepare('SELECT 1 AS found FROM events WHERE observed_at<? LIMIT 1').get(readFrom));
  return {summary,events:[...kept.values()].sort((a,b)=>a.observedAt-b.observedAt),from,to,truncatedBefore,firstSeen};
 }finally{if(!readOptions.database)db.close();}
}
const hasIssueKeys=(event:CaptureEvent)=>[event.data?.browserUrl,event.data?.browserTitle,event.data?.orcaSelectedTabTitle,event.data?.tabTitle].some(value=>issueKeys(value).length>0);
const canonicalProject=(value:string)=>{const path=value.includes('::')?value.split('::').at(-1)||value:value;return isAbsolute(path)?projectPathFromWorktree(path):path;};
const projectOf=(i:Interval)=>{const path=i.workspaceId?.split('::').at(-1);return path?canonicalProject(path):null;};
const issueKeys=(value:unknown):string[]=>typeof value==='string'?[...new Set([...value.slice(0,512).matchAll(/\b([a-z][a-z0-9]{1,15}-[1-9][0-9]{0,8})\b/gi)].map(match=>match[1]!.toUpperCase()).filter(key=>issuePattern.test(key)))]:[];
const workspaceIssueFromId=(workspaceId?:string)=>{const path=workspaceId?.split('::').at(-1);const keys=issueKeys(path?basename(path):'');return keys.length===1?keys[0]!:null;};
const workspaceIssue=(i:Interval)=>workspaceIssueFromId(i.workspaceId);
const agentInterval=(i:Interval)=>!i.child&&(i.state==='grouped'||i.attributionSource==='task-counter'&&i.state==='running');
/** Agent work for totals: main sessions and subagents. */
const agentWorkInterval=(i:Interval)=>i.state==='grouped'||i.attributionSource==='task-counter'&&i.state==='running';
const humanInterval=(i:Interval)=>i.state==='human';
const spans=(items:Interval[])=>items.map(i=>[i.start,i.end] as [number,number]);
const publicInterval=<T extends Interval>(i:T)=>{const {browserUrl,browserTitle,tabTitle,...safe}=i;return safe;};
function totals(items:Interval[]){
 const human=items.filter(humanInterval),agent=items.filter(agentWorkInterval),bySession=new Map<string,Interval[]>();
 // Cumulative: every main session and every subagent counted in full, like the app's agent time.
 for(const interval of agent){const key=agentSessionKey(interval);const group=bySession.get(key)||[];group.push(interval);bySession.set(key,group);}
 const humanActiveSeconds=minuteCreditSeconds(spans(human)),agentRunningSeconds=[...bySession.values()].reduce((sum,group)=>sum+minuteCreditSeconds(spans(group)),0),overlapMergedWallSeconds=minuteCreditSeconds(spans([...human,...agent]));
 const agentWallSeconds=minuteCreditSeconds(spans(agent));
 return {humanActiveSeconds,agentRunningSeconds,agentWallSeconds,overlapMergedWallSeconds,hours:{humanActive:(humanActiveSeconds/3600).toFixed(2),agentRunning:(agentRunningSeconds/3600).toFixed(2),agentWall:(agentWallSeconds/3600).toFixed(2),overlapMergedWall:(overlapMergedWallSeconds/3600).toFixed(2)}};
}
function perDay(rows:ReturnType<typeof attributedIntervals>){
 const pieces:typeof rows=[];
 for(const row of rows){let cursor=row.start;while(cursor<row.end){const date=dateOf(cursor),next=new Date(dateStart(date)*1000);next.setDate(next.getDate()+1);const end=Math.min(row.end,next.getTime()/1000);pieces.push({...row,start:cursor,end});cursor=end;}}
 return [...new Set(pieces.map(i=>dateOf(i.start)))].sort().map(date=>({date,...totals(pieces.filter(i=>dateOf(i.start)===date))}));
}
interface AttributionIndex {byCounter:Map<string,CaptureEvent>;bySession:Map<string,CaptureEvent[]>;byProject:Map<string,CaptureEvent[]>;pageKeys:Map<string,string[]>;}
function attributionIndex(events:CaptureEvent[]):AttributionIndex{
 const index:AttributionIndex={byCounter:new Map(),bySession:new Map(),byProject:new Map(),pageKeys:new Map()};
 for(const event of events){
  if(event.source==='agent_report'&&event.kind==='task_start')index.byCounter.set(event.eventId,event);
  if(event.source==='agent_report'&&event.kind==='work_context'){
   if(event.provider&&event.sessionId){const key=`${event.provider}:${event.sessionId}`,rows=index.bySession.get(key)||[];rows.push(event);index.bySession.set(key,rows);}
   if(typeof event.data?.project==='string'){const project=canonicalProject(event.data.project),rows=index.byProject.get(project)||[];rows.push(event);index.byProject.set(project,rows);}
  }
  if(event.source==='macos'&&event.kind==='activity'){
   const keys=[...new Set([...issueKeys(event.data?.browserUrl),...issueKeys(event.data?.browserTitle),...issueKeys(event.data?.orcaSelectedTabTitle),...issueKeys(event.data?.tabTitle)])];
   if(keys.length)index.pageKeys.set(event.eventId,keys);
  }
 }
 for(const rows of [...index.bySession.values(),...index.byProject.values()])rows.sort((a,b)=>a.observedAt-b.observedAt);
 return index;
}
function recent(rows:CaptureEvent[],at:number,maxAge:number):CaptureEvent[]{
 let low=0,high=rows.length;
 while(low<high){const middle=(low+high)>>>1;if(rows[middle]!.observedAt<=at)low=middle+1;else high=middle;}
 const result:CaptureEvent[]=[];
 for(let index=low-1;index>=0&&at-rows[index]!.observedAt<=maxAge;index--)result.push(rows[index]!);
 return result;
}
function contextFor(i:Interval,index:AttributionIndex):CaptureEvent|null{
 if(!i.sessionId||!i.provider)return null;
 return recent(index.bySession.get(`${i.provider}:${i.sessionId}`)||[],i.start,43200)[0]||null;
}
function suggestedIssue(i:Interval,index:AttributionIndex):{issueKey:string;evidence:string[]}|null{
 if(i.state!=='human')return null;
 const project=projectOf(i),candidates=project?recent(index.byProject.get(project)||[],i.end,1800).filter(e=>typeof e.data?.issueKey==='string'):[];
 const pageKeys=i.sourceEventIds.flatMap(id=>index.pageKeys.get(id)||[]);
 const keys=[...new Set([...candidates.map(e=>String(e.data?.issueKey)),...pageKeys])];
 return keys.length===1?{issueKey:keys[0]!,evidence:[...candidates.filter(e=>e.data?.issueKey===keys[0]).map(e=>e.eventId),...i.sourceEventIds.filter(id=>index.pageKeys.get(id)?.includes(keys[0]!))]}:null;
}
function attribution(i:Interval,index:AttributionIndex){
 const counter=i.attributionSource==='task-counter'?index.byCounter.get(i.sourceEventIds[0]||''):undefined;
 const context=counter||contextFor(i,index),issueKey=context?.data?.issueKey;
 const observedProject=projectOf(i),reportedProject=typeof context?.data?.project==='string'?canonicalProject(context.data.project):null;
 const suggestion=suggestedIssue(i,index);
 const reportedKey=typeof issueKey==='string'?issueKey:null,pathKey=workspaceIssue(i),issueConflict=Boolean(reportedKey&&pathKey&&reportedKey!==pathKey);
 return {issueKey:issueConflict?null:reportedKey||pathKey,project:counter?(reportedProject||observedProject):(observedProject||reportedProject),
  suggestedIssueKey:suggestion?.issueKey||null,
  confidence:counter?'agent-reported':issueConflict||context&&reportedProject&&observedProject&&reportedProject!==observedProject?'conflict':i.userAttribution==='assigned'?'manual':pathKey?'workspace-key':observedProject?'observed-project':context?'agent-reported':'unattributed',
  attributionRule:issueConflict?'conflicting-issue-signals':reportedKey?'agent-reported-session':pathKey?'orca-worktree-name':suggestion?'page-key-suggestion':'none',
  evidence:context?[...i.sourceEventIds,context.eventId]:suggestion?[...i.sourceEventIds,...suggestion.evidence]:i.sourceEventIds};
}
export const attributedIntervals=(s:Snapshot)=>{const index=attributionIndex(s.events);return s.summary.intervals.map(i=>({...i,...attribution(i,index)}));};
export function timeForIssue(s:Snapshot,issueKey:string){
 if(!ticketPattern.test(issueKey)||!issueKey.trim())throw new Error('Invalid ticket reference');
 const attributed=attributedIntervals(s),rows=attributed.filter(i=>i.issueKey===issueKey);
 const suggestions=attributed.filter(i=>i.state==='human'&&i.suggestedIssueKey===issueKey);
 const days=perDay(rows);
 return {issueKey,...totals(rows),days,intervals:rows.slice(0,500).map(publicInterval),moreIntervals:rows.length>500,
  suggestedHumanSeconds:totals(suggestions).humanActiveSeconds,suggestedHumanIntervals:suggestions.slice(0,100).map(publicInterval),moreSuggestedHumanIntervals:suggestions.length>100,
  captureCoverage:coverage(s),attribution:'Agent-reported issue context is advisory; measured time is not a billing approval',truncatedBefore:s.truncatedBefore};
}
export function timeForProject(s:Snapshot,project:string){return timeForProjectSet(s,[project],project);}
export function timeForProjectSet(s:Snapshot,projects:string[],project:string){
 if(!project||project.length>512)throw new Error('Invalid project');
 const normalized=canonicalProject(project),accepted=new Set(projects.map(canonicalProject)),rows=attributedIntervals(s).filter(i=>i.project!==null&&accepted.has(i.project));
 const issues=[...new Set(rows.map(i=>i.issueKey||'Unmatched'))].sort().map(issueKey=>({issueKey,...totals(rows.filter(i=>(i.issueKey||'Unmatched')===issueKey))}));
 return {project:normalized,...totals(rows),issues,days:perDay(rows),captureCoverage:coverage(s),truncatedBefore:s.truncatedBefore};
}
export function timeline(s:Snapshot,project?:string){
 const normalized=project?canonicalProject(project):undefined,rows=attributedIntervals(s).filter(i=>!normalized||i.project===normalized);
 const measured=rows.filter(i=>humanInterval(i)||agentInterval(i));
 const boundaries=measured.flatMap((row,index)=>[{at:row.start,index,open:true},{at:row.end,index,open:false}]).sort((a,b)=>a.at-b.at||Number(a.open)-Number(b.open));
 const active=new Set<number>(),segments:Array<{start:number;end:number;state:'human'|'agent'|'both';agentCount:number;projects:string[];issueKeys:string[];sourceEventIds:string[]}>=[];
 let previous:number|null=null,segmentCount=0;
 for(let offset=0;offset<boundaries.length;){const at=boundaries[offset]!.at;
  if(previous!==null&&at>previous&&active.size){
   segmentCount++;
   if(segments.length<500){const current=[...active].map(index=>measured[index]!),human=current.some(humanInterval),agents=current.filter(agentInterval);
    segments.push({start:previous,end:at,state:human&&agents.length?'both':human?'human':'agent',agentCount:agents.length,projects:[...new Set(current.map(i=>i.project).filter((value):value is string=>Boolean(value)))],issueKeys:[...new Set(current.map(i=>i.issueKey).filter((value):value is string=>Boolean(value)))],sourceEventIds:[...new Set(current.flatMap(i=>i.evidence))].slice(0,32)});
   }
  }
  while(offset<boundaries.length&&boundaries[offset]!.at===at){const boundary=boundaries[offset++]!;if(boundary.open)active.add(boundary.index);else active.delete(boundary.index);}
  previous=at;
 }
 return {segments,moreSegments:segmentCount>500,totals:totals(rows),truncatedBefore:s.truncatedBefore};
}
export function sessions(s:Snapshot,filter:{provider?:string;workspace?:string;issueKey?:string}){
 const index=attributionIndex(s.events),firstSeen=s.firstSeen||new Map<string,number>();
 if(!s.firstSeen)for(const event of s.events)if(event.provider&&event.sessionId){const key=`${event.provider}:${event.sessionId}`;firstSeen.set(key,Math.min(firstSeen.get(key)??Infinity,event.observedAt));}
 const rows=s.summary.sessions.filter(session=>session.lastObservedAt>=s.from&&session.lastObservedAt<s.to&&
  (!filter.provider||session.provider===filter.provider)&&(!filter.workspace||session.workspaceId===filter.workspace));
 const linked=rows.map(session=>{
  const key=`${session.provider}:${session.sessionId}`,workspaceKey=workspaceIssueFromId(session.workspaceId),reportedKeys=[...new Set((index.bySession.get(key)||[]).map(e=>e.data?.issueKey).filter((value):value is string=>typeof value==='string'))];
  return {session,issueKeys:[...new Set([...(workspaceKey?[workspaceKey]:[]),...reportedKeys])],firstObservedAt:firstSeen.get(key)||null};
 });
 const filtered=filter.issueKey?linked.filter(row=>row.issueKeys.includes(filter.issueKey!)):linked;
 return {sessions:filtered.slice(0,500).map(({session,issueKeys,firstObservedAt})=>{const {title,cwd,...safe}=session;return {...safe,firstObservedAt,issueKeys};}),moreSessions:filtered.length>500,truncatedBefore:s.truncatedBefore};
}
export function coverage(s:Snapshot){
 const issues=[...s.summary.coverage,...s.summary.unresolved].filter(i=>i.observedAt===undefined||i.observedAt>=s.from&&i.observedAt<s.to);
 const gaps=unobservedGaps(s.summary.intervals);
 const permissionPeriods:Array<{start:number;end:number;reason:string}>=[];
 let permissionOpen=false;
 for(const event of s.events.filter(e=>e.source==='macos'&&e.kind==='activity'&&e.observedAt>=s.from&&e.observedAt<s.to).sort((a,b)=>a.observedAt-b.observedAt)){
  if(event.data?.accessibilityTrusted!==false){permissionOpen=false;continue;}
  const last=permissionPeriods.at(-1);
  if(permissionOpen&&last&&event.observedAt-last.end<=60)last.end=event.observedAt;
  else permissionPeriods.push({start:event.observedAt,end:event.observedAt,reason:'Accessibility permission missing; foreground capture can continue but tab attribution is limited'});
  permissionOpen=true;
 }
 return {issues:issues.slice(0,500),moreIssues:issues.length>500,gaps:gaps.slice(0,500),permissionPeriods:permissionPeriods.slice(0,500),morePermissionPeriods:permissionPeriods.length>500,truncatedBefore:s.truncatedBefore};
}
/** Historical coverage can span many more events than a time reduction. Stream only the evidence needed here. */
export function coverageForRange(output:string,from:number,to:number){
 const db=database(output);try{
  const issues=db.prepare(`SELECT observed_at,payload FROM events ${isPackedEventDatabase(db)?'INDEXED BY events_coverage_at':''} WHERE observed_at>=? AND observed_at<? AND json_extract(payload,'$.kind')='coverage' ORDER BY observed_at LIMIT 501`).all(from,to);
  const permissionPeriods:Array<{start:number;end:number;reason:string}>=[],observationGaps:Array<{start:number;end:number;reason:string}>=[];
  let permissionOpen=false,previous:number|null=null;
  const permissionQuery=isPackedEventDatabase(db)?'SELECT observed_at,accessibility_trusted trusted FROM events WHERE observed_at>=? AND observed_at<? AND activity_sample=1 ORDER BY observed_at':"SELECT observed_at,json_extract(payload,'$.data.accessibilityTrusted') AS trusted FROM events WHERE observed_at>=? AND observed_at<? AND json_extract(payload,'$.source')='macos' AND json_extract(payload,'$.kind')='activity' ORDER BY observed_at";
  for(const row of db.prepare(permissionQuery).iterate(from,to)){
   const at=Number(row.observed_at);
   if(previous!==null&&at-previous>300)observationGaps.push({start:previous,end:at,reason:'No macOS observations; pause, sleep or collector interruption requires review'});
   if(row.trusted===0){
    const last=permissionPeriods.at(-1);
    if(permissionOpen&&last&&at-last.end<=60)last.end=at;
    else permissionPeriods.push({start:at,end:at,reason:'Accessibility permission missing; tab attribution is limited'});
    permissionOpen=true;
   }else permissionOpen=false;
   previous=at;
  }
  return {issues:issues.slice(0,500).map(row=>{const event=JSON.parse(String(row.payload)) as CaptureEvent;return {source:event.source,observedAt:event.observedAt,reason:String(event.data?.reason||'Capture coverage notice').slice(0,300),eventId:event.eventId};}),moreIssues:issues.length>500,
   permissionPeriods:permissionPeriods.slice(0,500),morePermissionPeriods:permissionPeriods.length>500,observationGaps:observationGaps.slice(0,500),moreObservationGaps:observationGaps.length>500};
 }finally{db.close();}
}
export function unattributed(s:Snapshot){
 const groups=groupHumanReview(s.summary.intervals).filter(g=>['unmatched','conflict'].includes(humanReviewState(g)));
 const index=attributionIndex(s.events);
 return {groups:groups.slice(0,500).map(g=>{
  const interval=s.summary.intervals.find(i=>i.state==='human'&&i.start>=g.start&&i.end<=g.end);
  return {start:g.start,end:g.end,seconds:g.seconds,label:interval?.browserDomain||interval?.foregroundName||interval?.foregroundBundleId||'Mac activity',projectPath:g.projectPath||null,reason:humanReviewState(g),eventIds:g.pairs.flat(),suggestedIssueKey:interval?suggestedIssue(interval,index)?.issueKey||null:null};
 }),moreGroups:groups.length>500};
}
export function explainAttribution(s:Snapshot,eventId:string){
 if(!uuidPattern.test(eventId))throw new Error('Invalid event ID');
 const interval=s.summary.intervals.find(i=>i.sourceEventIds.includes(eventId));
 if(!interval)return {eventId,found:false};
 return {eventId,found:true,interval:publicInterval({...interval,...attribution(interval,attributionIndex(s.events))}),note:'Reported context is a suggestion; only observed intervals contribute measured time'};
}

export function readReport(output:string,requestId:string):CaptureEvent|null{
 if(!uuidPattern.test(requestId))throw new Error('Invalid request ID');
 const path=join(output,'spool',`${requestId}.json`);
 if(existsSync(path))return JSON.parse(readFileSync(path,'utf8')) as CaptureEvent;
 if(!existsSync(join(output,'events.sqlite')))return null;
 const db=database(output);try{const row=db.prepare('SELECT payload FROM events WHERE event_id=?').get(requestId);return row?JSON.parse(String(row.payload)) as CaptureEvent:null;}finally{db.close();}
}
export function inferRecentSession(output:string,provider:string,workspaceId?:string):string|null{
 if(!['claude','codex'].includes(provider)||!existsSync(join(output,'events.sqlite')))return null;
 const db=database(output);try{
  const rows=db.prepare("SELECT payload FROM events WHERE observed_at>? AND json_extract(payload,'$.source')='hook' AND json_extract(payload,'$.provider')=? ORDER BY observed_at DESC LIMIT 500").all(now()-120,provider);
  const latest=new Map<string,CaptureEvent>();
  for(const row of rows){const event=JSON.parse(String(row.payload)) as CaptureEvent;if(!event.sessionId||latest.has(event.sessionId)||workspaceId&&event.workspaceId!==workspaceId)continue;latest.set(event.sessionId,event);}
  const active=[...latest.values()].filter(event=>event.kind!=='session_end');
  return active.length===1?active[0]!.sessionId!:null;
 }finally{db.close();}
}
export function writeReport(output:string,kind:CaptureEvent['kind'],requestId:string,contextId:string,data:Record<string,unknown>,identity:{provider?:string;sessionId?:string;workspaceId?:string}={}):CaptureEvent{
 if(!uuidPattern.test(requestId)||!uuidPattern.test(contextId))throw new Error('Use UUIDs for requestId and contextId');
 const intended=JSON.parse(JSON.stringify({requestId,contextId,...data})) as Record<string,unknown>;
 const existing=readReport(output,requestId);
 if(existing){if(existing.kind!==kind||JSON.stringify(existing.data)!==JSON.stringify(intended))throw new Error('Request ID already used for a different declaration');return existing;}
 const event=makeEvent('agent_report',kind,{eventId:requestId,provider:identity.provider,sessionId:identity.sessionId,workspaceId:identity.workspaceId,data:intended});
 if(!validAgentReport(event))throw new Error('Invalid agent declaration');
 const directory=join(output,'spool');mkdirSync(directory,{recursive:true,mode:0o700});
 const info=lstatSync(directory);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Invalid collector spool');
 const listing=boundedSpoolListing(directory,MAX_PENDING_HOOKS+16);if(existsSync(join(output,'storage-paused.json'))||listing.truncated||listing.files.filter(name=>name.endsWith('.json')||name.endsWith('.tmp')).length>=MAX_PENDING_HOOKS||Buffer.byteLength(JSON.stringify(event))>MAX_HOOK_BYTES)throw new Error('Agent Time storage is paused or its event queue is full; resume capture before reporting more work');
 const temporary=join(directory,`${randomUUID()}.tmp`),final=join(directory,`${requestId}.json`);
 try{
  writeFileSync(temporary,JSON.stringify(event),{mode:0o600,flag:'wx'});
  try{linkSync(temporary,final);}catch(error){
   if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
   const prior=readReport(output,requestId);
   if(!prior||prior.kind!==kind||JSON.stringify(prior.data)!==JSON.stringify(intended))throw new Error('Request ID already used for a different declaration');
   return prior;
  }
 }finally{if(existsSync(temporary))unlinkSync(temporary);}
 return event;
}
export function currentWork(output:string){
 const db=existsSync(join(output,'events.sqlite'))?database(output):null;try{
  const rows=db?.prepare(`SELECT payload FROM events ${reportIndex(db)} WHERE observed_at>? AND json_extract(payload,'$.source')='agent_report' ORDER BY observed_at DESC LIMIT 2001`).all(now()-43200)||[];
  const reports=hydrateReports(db,[...rows.slice(0,2000).map(r=>JSON.parse(String(r.payload)) as CaptureEvent),...pendingReports(output)]).sort((a,b)=>a.observedAt-b.observedAt);
  const sessionEnds=new Map<string,number>();
  for(const row of db?.prepare(`SELECT payload FROM events ${db&&isPackedEventDatabase(db)?'INDEXED BY events_session_ends_at':''} WHERE observed_at>? AND json_extract(payload,'$.kind')='session_end' ORDER BY observed_at`).all(now()-43200)||[]){const event=JSON.parse(String(row.payload)) as CaptureEvent;if(event.provider&&event.sessionId)sessionEnds.set(`${event.provider}:${event.sessionId}`,event.observedAt);}
  const contexts=new Map<string,CaptureEvent>(),starts=new Map<string,CaptureEvent>(),stops=new Set<string>(),ports=new Map<number,CaptureEvent>();
  for(const e of reports){
   const id=String(e.data?.contextId||'');
   if(e.kind==='work_context')contexts.set(id,e);
   if(e.kind==='task_start')starts.set(e.eventId,e);
   if(e.kind==='task_stop')stops.add(String(e.data?.taskCounterId));
   if(e.kind==='port_state')ports.set(Number(e.data?.port),e);
  }
  return {truncated:rows.length>2000,contexts:[...contexts.values()].filter(e=>!e.provider||!e.sessionId||(sessionEnds.get(`${e.provider}:${e.sessionId}`)||0)<e.observedAt).map(e=>({contextId:e.data?.contextId,issueKey:e.data?.issueKey,project:e.data?.project,task:e.data?.task,agentIdentity:e.data?.agentIdentity,billable:e.data?.billable,reportedAt:e.observedAt,provider:e.provider,sessionId:e.sessionId})),
   tasks:reportedWorkForDay(reports,now()-43200,now()+1,now(),sessionEnds).filter(item=>item.kind==='counter'&&!stops.has(item.id)&&item.status!=='session-ended').map(item=>({...item,taskCounterId:item.id,name:item.title,reportedElapsedSeconds:Math.round(item.end-item.start),measured:false})),
   ports:[...ports.values()].map(e=>({port:e.data?.port,state:e.data?.state,verified:e.data?.verified,processId:e.data?.processId,reportedAt:e.observedAt}))};
 }finally{db?.close();}
}
export function verifyPort(port:number):{verified:boolean;processId:number|null}{
 if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid TCP port');
 try{
  const result=execFileSync('/usr/sbin/lsof',['-nP','-a',`-iTCP:${port}`,'-sTCP:LISTEN','-Fpcn'],{encoding:'utf8',timeout:1500,maxBuffer:16_384});
  const pid=Number(result.match(/^p(\d+)$/m)?.[1]);return {verified:true,processId:Number.isSafeInteger(pid)&&pid>0?pid:null};
 }catch(error){
  if((error as NodeJS.ErrnoException).code==='ENOENT')return {verified:false,processId:null};
  if((error as {status?:number}).status===1)return {verified:true,processId:null};
  return {verified:false,processId:null};
 }
}

/** Task writes share native identity and snapshot context once, so later topic changes cannot move an existing counter. */
export function writeTaskReport(output:string,kind:CaptureEvent['kind'],requestId:string,contextId:string,data:Record<string,unknown>,identity:{provider?:string;sessionId?:string;workspaceId?:string}={}):CaptureEvent{
 if(kind==='task_start'){
  const parent=data.parentTaskCounterId?readReport(output,String(data.parentTaskCounterId)):undefined;
  if(data.parentTaskCounterId&&parent?.kind!=='task_start')throw new Error('Unknown parent task counter');
  const db=existsSync(join(output,'events.sqlite'))?database(output):null;
  let context:CaptureEvent|undefined;
  try{const row=db?.prepare(`SELECT payload FROM events ${reportIndex(db)} WHERE observed_at>? AND json_extract(payload,'$.source')='agent_report' AND json_extract(payload,'$.kind')='work_context' AND json_extract(payload,'$.data.contextId')=? ORDER BY observed_at DESC LIMIT 1`).get(now()-43200,contextId);if(row)context=JSON.parse(String(row.payload));}finally{db?.close();}
  for(const e of pendingReports(output))if(e.kind==='work_context'&&e.data?.contextId===contextId&&(!context||e.observedAt>=context.observedAt))context=e;
  if(context&&(['provider','sessionId','workspaceId'] as const).some(key=>identity[key]&&context?.[key]&&identity[key]!==context[key]))context=undefined;
  const inherited:Record<string,unknown>={};
  for(const key of ['project','issueKey','agentIdentity','billable'] as const){const value=context?context.data?.[key]:(key!=='agentIdentity'?parent?.data?.[key]:undefined);if(value!==undefined&&(value!==null||key==='billable'))inherited[key]=value;}
  // Reuse the original inherited snapshot on retries; explicit fields are still compared by writeReport.
  const existing=readReport(output,requestId);
  if(existing?.kind==='task_start')for(const key of ['project','issueKey','agentIdentity','billable'] as const)if(data[key]===undefined){delete inherited[key];if(existing.data?.[key]!==undefined)inherited[key]=existing.data[key];}
  return writeReport(output,kind,requestId,contextId,{...inherited,...data,leaseSeconds:data.leaseSeconds??900},identity);
 }
 if(kind!=='task_stop'&&kind!=='task_heartbeat')throw new Error('Invalid task operation');
 const start=readReport(output,String(data.taskCounterId));if(start?.kind!=='task_start')throw new Error('Unknown task counter');
 for(const key of ['provider','sessionId','workspaceId'] as const)if(identity[key]&&start[key]&&identity[key]!==start[key])throw new Error('Task counter belongs to a different native session or workspace');
 const existing=readReport(output,requestId);
 if(!existing){
  const db=existsSync(join(output,'events.sqlite'))?database(output):null;
  const evidence:CaptureEvent[]=[start,...pendingReports(output).filter(e=>e.data?.taskCounterId===start.eventId)];
  try{
   for(const kind of ['task_stop','task_heartbeat']){const row=db?.prepare(`SELECT payload FROM events ${reportIndex(db)} WHERE observed_at>=? AND json_extract(payload,'$.source')='agent_report' AND json_extract(payload,'$.kind')=? AND json_extract(payload,'$.data.taskCounterId')=? ORDER BY observed_at DESC LIMIT 1`).get(start.observedAt,kind,start.eventId);if(row)evidence.push(JSON.parse(String(row.payload)));}
   if(start.provider&&start.sessionId){const row=db?.prepare(`SELECT payload FROM events ${endIndex(db)} WHERE observed_at>=? AND json_extract(payload,'$.kind')='session_end' AND json_extract(payload,'$.provider')=? AND json_extract(payload,'$.sessionId')=? ORDER BY observed_at LIMIT 1`).get(start.observedAt,start.provider,start.sessionId);if(row)evidence.push(JSON.parse(String(row.payload)));}
  }finally{db?.close();}
  const item=reportedWorkForDay(evidence,start.observedAt,now()+1,now())[0];
  if(item&&['completed','failed','cancelled','session-ended'].includes(item.status||''))throw new Error('Task counter is already closed');
  if(kind==='task_heartbeat'&&(!item||item.status==='interrupted'))throw new Error('Task counter expired; stop it and start a new counter');
 }
 return writeReport(output,kind,requestId,contextId,data,{provider:start.provider,sessionId:start.sessionId,workspaceId:start.workspaceId});
}

/** Reads reports only, with an explicit cap: never replay the capture database to list task metadata. */
export function taskHistory(output:string,from:number,to:number,filter:{project?:string;issueKey?:string;agentId?:string}={}){
 if(!Number.isFinite(from)||!Number.isFinite(to)||to<=from||to-from>31*86400)throw new Error('Invalid bounded task range');
 const db=existsSync(join(output,'events.sqlite'))?database(output):null;
 try{
  const rows=db?.prepare(`SELECT payload FROM events ${reportIndex(db)} WHERE observed_at>=? AND observed_at<? AND json_extract(payload,'$.source')='agent_report' ORDER BY observed_at LIMIT 10001`).all(from-43200,to+43200)||[];
  const ends=db?.prepare(`SELECT payload FROM events ${endIndex(db)} WHERE observed_at>=? AND observed_at<? AND json_extract(payload,'$.kind')='session_end' ORDER BY observed_at LIMIT 10001`).all(from-43200,to+43200)||[];
  const reports=new Map<string,CaptureEvent>();for(const row of [...rows.slice(0,10000),...ends.slice(0,10000)]){const e=JSON.parse(String(row.payload)) as CaptureEvent;reports.set(e.eventId,e);}for(const e of pendingReports(output))if(e.observedAt>=from-43200&&e.observedAt<to+43200)reports.set(e.eventId,e);
  const tasks=reportedWorkForDay(hydrateReports(db,[...reports.values()]),from,to,now()).filter(item=>item.kind==='counter'&&(!filter.project||item.project===filter.project)&&(!filter.issueKey||item.issueKey===filter.issueKey)&&(!filter.agentId||item.agentIdentity?.id===filter.agentId));
  return {tasks:tasks.slice(0,1000).map(item=>({...item,taskCounterId:item.id,reportedElapsedSeconds:Math.max(0,Math.round(item.end-Math.max(from,item.start))),usageVerified:false})),truncated:rows.length>10000||ends.length>10000||tasks.length>1000,measured:false,usageScope:'own-task-only',durationScope:'parent-inclusive; do not sum parent and child durations'};
 }finally{db?.close();}
}
