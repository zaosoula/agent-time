import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {existsSync,linkSync,lstatSync,mkdirSync,readFileSync,readdirSync,unlinkSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {basename,isAbsolute,join} from 'node:path';
import {homedir} from 'node:os';
import {makeEvent,type CaptureEvent,type Interval,type Summary} from '../capture/events.ts';
import {minuteCreditSeconds,summarize} from '../capture/correlate.ts';
import {applyHumanDecisions,groupHumanReview,humanReviewState,type HumanDecision,type HumanSplit} from '../capture/human-review.ts';
import {unobservedGaps} from '../capture/gaps.ts';
import {projectPathFromWorktree} from '../capture/website-resolver.ts';
import {issuePattern,uuidPattern,validAgentReport} from './report.ts';

export const defaultDataDirectory=()=>process.env.ADE_CAPTURE_OUTPUT||join(homedir(),'Library','Application Support','studio.ezyo.agenttime');
const maxEvents=250_000;
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
 return new DatabaseSync(path,{readOnly});
}
function pendingReports(output:string):CaptureEvent[]{
 const events:CaptureEvent[]=[],spool=join(output,'spool');
 if(!existsSync(spool))return events;
 for(const name of readdirSync(spool).filter(name=>name.endsWith('.json')).slice(0,2000))try{
  const path=join(spool,name),info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink()||info.size>2048)continue;
  const event=JSON.parse(readFileSync(path,'utf8')) as CaptureEvent;if(validAgentReport(event))events.push(event);
 }catch{/* Ignore incomplete or invalid spool entries. */}
 return events;
}
export interface Snapshot {summary:Summary;events:CaptureEvent[];from:number;to:number;truncatedBefore:boolean;}
export function snapshot(output:string,from:number,to:number):Snapshot{
 if(!Number.isFinite(from)||!Number.isFinite(to)||to<=from||to-from>31*86400)throw new Error('Invalid bounded time range');
 const db=database(output),lookback=Math.max(0,from-3600);
 try{
  const count=Number(db.prepare('SELECT COUNT(*) AS count FROM events WHERE observed_at>=? AND observed_at<?').get(lookback,to)?.count||0);
  if(count>maxEvents)throw new Error('Too many events for one query; use a shorter date range');
  const events:CaptureEvent[]=[];
  for(const row of db.prepare('SELECT payload FROM events WHERE observed_at>=? AND observed_at<? ORDER BY rowid').iterate(lookback,to)){
   if(events.length>=maxEvents)throw new Error('Too many events for one query; use a shorter date range');
   events.push(JSON.parse(String(row.payload)) as CaptureEvent);
  }
  events.push(...pendingReports(output).filter(e=>e.observedAt>=lookback&&e.observedAt<to));
  const decisions=db.prepare('SELECT start_event_id,end_event_id,mode,project_path FROM human_decisions').all().map(row=>({startEventId:String(row.start_event_id),endEventId:String(row.end_event_id),mode:row.mode,projectPath:row.project_path===null?null:String(row.project_path)})) as HumanDecision[];
  const splits=db.prepare('SELECT start_event_id,end_event_id,split_at,before_path,after_path FROM human_splits').all().map(row=>({startEventId:String(row.start_event_id),endEventId:String(row.end_event_id),splitAt:Number(row.split_at),beforePath:row.before_path===null?null:String(row.before_path),afterPath:row.after_path===null?null:String(row.after_path)})) as HumanSplit[];
  const settingsPath=join(output,'settings.json');let settings:Record<string,unknown>={};
  if(existsSync(settingsPath))try{settings=JSON.parse(readFileSync(settingsPath,'utf8'));}catch{/* Use collector defaults for invalid settings. */}
  const idle=Number(settings.humanIdleMinutes),agentIdle=Number(settings.agentIdleMinutes);
  const summary=applyHumanDecisions(summarize(events,{idleThreshold:Number.isFinite(idle)&&idle>0?idle*60:300,agentIdleThreshold:Number.isFinite(agentIdle)&&agentIdle>0?agentIdle*60:300}),decisions,splits);
  const clipped=summary.intervals.filter(i=>i.end>from&&i.start<to).map(i=>({...i,start:Math.max(from,i.start),end:Math.min(to,i.end)}));
  const underlying=new Map<string,Interval[]>(),sessionPaths=new Map<string,string>();
  for(const source of summary.intervals)if(source.state!=='grouped'&&source.state!=='human'&&source.sessionId){const key=`${source.provider}:${source.sessionId}`;const group=underlying.get(key)||[];group.push(source);underlying.set(key,group);}
  for(const session of summary.sessions)if(session.cwd&&session.sessionId)sessionPaths.set(`${session.provider}:${session.sessionId}`,session.cwd);
  for(const interval of clipped)if(interval.state==='grouped'&&!interval.sourceEventIds.length){
   interval.sourceEventIds=[...new Set((underlying.get(`${interval.provider}:${interval.sessionId}`)||[]).filter(source=>source.end>interval.start&&source.start<interval.end).flatMap(source=>source.sourceEventIds))].slice(0,32);
  }
  for(const interval of clipped)if(!interval.workspaceId&&interval.sessionId){
   const cwd=sessionPaths.get(`${interval.provider}:${interval.sessionId}`);
   if(cwd)interval.workspaceId=`session::${projectPathFromWorktree(cwd)}`;
  }
  const truncatedBefore=Boolean(db.prepare('SELECT 1 AS found FROM events WHERE observed_at<? LIMIT 1').get(lookback));
  return {summary:{...summary,intervals:clipped},events,from,to,truncatedBefore};
 }finally{db.close();}
}
const canonicalProject=(value:string)=>{const path=value.includes('::')?value.split('::').at(-1)||value:value;return isAbsolute(path)?projectPathFromWorktree(path):path;};
const projectOf=(i:Interval)=>{const path=i.workspaceId?.split('::').at(-1);return path?canonicalProject(path):null;};
const issueKeys=(value:unknown):string[]=>typeof value==='string'?[...new Set([...value.slice(0,512).matchAll(/\b([a-z][a-z0-9]{1,15}-[1-9][0-9]{0,8})\b/gi)].map(match=>match[1]!.toUpperCase()).filter(key=>issuePattern.test(key)))]:[];
const workspaceIssueFromId=(workspaceId?:string)=>{const path=workspaceId?.split('::').at(-1);const keys=issueKeys(path?basename(path):'');return keys.length===1?keys[0]!:null;};
const workspaceIssue=(i:Interval)=>workspaceIssueFromId(i.workspaceId);
const agentInterval=(i:Interval)=>!i.child&&i.state==='grouped';
const humanInterval=(i:Interval)=>i.state==='human';
const spans=(items:Interval[])=>items.map(i=>[i.start,i.end] as [number,number]);
const publicInterval=<T extends Interval>(i:T)=>{const {browserUrl,browserTitle,tabTitle,...safe}=i;return safe;};
function totals(items:Interval[]){
 const human=items.filter(humanInterval),agent=items.filter(agentInterval),bySession=new Map<string,Interval[]>();
 for(const interval of agent){const key=JSON.stringify([interval.hostId,interval.dispatchId||interval.sessionId]);const group=bySession.get(key)||[];group.push(interval);bySession.set(key,group);}
 const humanActiveSeconds=minuteCreditSeconds(spans(human)),agentRunningSeconds=[...bySession.values()].reduce((sum,group)=>sum+minuteCreditSeconds(spans(group)),0),overlapMergedWallSeconds=minuteCreditSeconds(spans([...human,...agent]));
 return {humanActiveSeconds,agentRunningSeconds,overlapMergedWallSeconds,hours:{humanActive:(humanActiveSeconds/3600).toFixed(2),agentRunning:(agentRunningSeconds/3600).toFixed(2),overlapMergedWall:(overlapMergedWallSeconds/3600).toFixed(2)}};
}
function perDay(rows:ReturnType<typeof inRange>){
 const pieces:typeof rows=[];
 for(const row of rows){let cursor=row.start;while(cursor<row.end){const date=dateOf(cursor),next=new Date(dateStart(date)*1000);next.setDate(next.getDate()+1);const end=Math.min(row.end,next.getTime()/1000);pieces.push({...row,start:cursor,end});cursor=end;}}
 return [...new Set(pieces.map(i=>dateOf(i.start)))].sort().map(date=>({date,...totals(pieces.filter(i=>dateOf(i.start)===date))}));
}
interface AttributionIndex {bySession:Map<string,CaptureEvent[]>;byProject:Map<string,CaptureEvent[]>;pageKeys:Map<string,string[]>;}
function attributionIndex(events:CaptureEvent[]):AttributionIndex{
 const index:AttributionIndex={bySession:new Map(),byProject:new Map(),pageKeys:new Map()};
 for(const event of events){
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
 const context=contextFor(i,index),issueKey=context?.data?.issueKey;
 const observedProject=projectOf(i),reportedProject=typeof context?.data?.project==='string'?canonicalProject(context.data.project):null;
 const suggestion=suggestedIssue(i,index);
 const reportedKey=typeof issueKey==='string'?issueKey:null,pathKey=workspaceIssue(i),issueConflict=Boolean(reportedKey&&pathKey&&reportedKey!==pathKey);
 return {issueKey:issueConflict?null:reportedKey||pathKey,project:observedProject||reportedProject,
  suggestedIssueKey:suggestion?.issueKey||null,
  confidence:issueConflict||context&&reportedProject&&observedProject&&reportedProject!==observedProject?'conflict':i.userAttribution==='assigned'?'manual':pathKey?'workspace-key':observedProject?'observed-project':context?'agent-reported':'unattributed',
  attributionRule:issueConflict?'conflicting-issue-signals':reportedKey?'agent-reported-session':pathKey?'orca-worktree-name':suggestion?'page-key-suggestion':'none',
  evidence:context?[...i.sourceEventIds,context.eventId]:suggestion?[...i.sourceEventIds,...suggestion.evidence]:i.sourceEventIds};
}
const inRange=(s:Snapshot)=>{const index=attributionIndex(s.events);return s.summary.intervals.map(i=>({...i,...attribution(i,index)}));};
export function timeForIssue(s:Snapshot,issueKey:string){
 if(!issuePattern.test(issueKey))throw new Error('Invalid Linear issue key');
 const attributed=inRange(s),rows=attributed.filter(i=>i.issueKey===issueKey);
 const suggestions=attributed.filter(i=>i.state==='human'&&i.suggestedIssueKey===issueKey);
 const days=perDay(rows);
 return {issueKey,...totals(rows),days,intervals:rows.slice(0,500).map(publicInterval),moreIntervals:rows.length>500,
  suggestedHumanSeconds:totals(suggestions).humanActiveSeconds,suggestedHumanIntervals:suggestions.slice(0,100).map(publicInterval),moreSuggestedHumanIntervals:suggestions.length>100,
  captureCoverage:coverage(s),attribution:'Agent-reported issue context is advisory; measured time is not a billing approval',truncatedBefore:s.truncatedBefore};
}
export function timeForProject(s:Snapshot,project:string){
 if(!project||project.length>512)throw new Error('Invalid project');
 const normalized=canonicalProject(project),rows=inRange(s).filter(i=>i.project===normalized);
 const issues=[...new Set(rows.map(i=>i.issueKey||'Unmatched'))].sort().map(issueKey=>({issueKey,...totals(rows.filter(i=>(i.issueKey||'Unmatched')===issueKey))}));
 return {project:normalized,...totals(rows),issues,days:perDay(rows),captureCoverage:coverage(s),truncatedBefore:s.truncatedBefore};
}
export function timeline(s:Snapshot,project?:string){
 const normalized=project?canonicalProject(project):undefined,rows=inRange(s).filter(i=>!normalized||i.project===normalized);
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
 const index=attributionIndex(s.events),firstSeen=new Map<string,number>();
 for(const event of s.events)if(event.provider&&event.sessionId){const key=`${event.provider}:${event.sessionId}`;firstSeen.set(key,Math.min(firstSeen.get(key)??Infinity,event.observedAt));}
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
  const issues=db.prepare("SELECT observed_at,payload FROM events WHERE observed_at>=? AND observed_at<? AND json_extract(payload,'$.kind')='coverage' ORDER BY observed_at LIMIT 501").all(from,to);
  const permissionPeriods:Array<{start:number;end:number;reason:string}>=[],observationGaps:Array<{start:number;end:number;reason:string}>=[];
  let permissionOpen=false,previous:number|null=null;
  for(const row of db.prepare("SELECT observed_at,json_extract(payload,'$.data.accessibilityTrusted') AS trusted FROM events WHERE observed_at>=? AND observed_at<? AND json_extract(payload,'$.source')='macos' AND json_extract(payload,'$.kind')='activity' ORDER BY observed_at").iterate(from,to)){
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
  const rows=db?.prepare("SELECT payload FROM events WHERE observed_at>? AND json_extract(payload,'$.source')='agent_report' ORDER BY observed_at DESC LIMIT 2000").all(now()-43200)||[];
  const reports=[...rows.map(r=>JSON.parse(String(r.payload)) as CaptureEvent),...pendingReports(output)].sort((a,b)=>a.observedAt-b.observedAt);
  const sessionEnds=new Map<string,number>();
  for(const row of db?.prepare("SELECT payload FROM events WHERE observed_at>? AND json_extract(payload,'$.kind')='session_end' ORDER BY observed_at").all(now()-43200)||[]){const event=JSON.parse(String(row.payload)) as CaptureEvent;if(event.provider&&event.sessionId)sessionEnds.set(`${event.provider}:${event.sessionId}`,event.observedAt);}
  const contexts=new Map<string,CaptureEvent>(),starts=new Map<string,CaptureEvent>(),stops=new Set<string>(),ports=new Map<number,CaptureEvent>();
  for(const e of reports){
   const id=String(e.data?.contextId||'');
   if(e.kind==='work_context')contexts.set(id,e);
   if(e.kind==='task_start')starts.set(e.eventId,e);
   if(e.kind==='task_stop')stops.add(String(e.data?.taskCounterId));
   if(e.kind==='port_state')ports.set(Number(e.data?.port),e);
  }
  return {contexts:[...contexts.values()].filter(e=>!e.provider||!e.sessionId||(sessionEnds.get(`${e.provider}:${e.sessionId}`)||0)<e.observedAt).map(e=>({contextId:e.data?.contextId,issueKey:e.data?.issueKey,project:e.data?.project,task:e.data?.task,reportedAt:e.observedAt,provider:e.provider,sessionId:e.sessionId})),
   tasks:[...starts.values()].filter(e=>!stops.has(e.eventId)&&(!e.provider||!e.sessionId||(sessionEnds.get(`${e.provider}:${e.sessionId}`)||0)<e.observedAt)).map(e=>({taskCounterId:e.eventId,name:e.data?.name,issueKey:e.data?.issueKey,reportedElapsedSeconds:Math.round(now()-e.observedAt),measured:false})),
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
