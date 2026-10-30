import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {existsSync,linkSync,lstatSync,mkdirSync,readFileSync,readdirSync,unlinkSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
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
  const rows=db.prepare('SELECT payload FROM events WHERE observed_at>=? AND observed_at<? ORDER BY rowid LIMIT ?').all(lookback,to,maxEvents+1);
  if(rows.length>maxEvents)throw new Error('Too many events for one query; use a shorter date range');
  const events=[...rows.map(row=>JSON.parse(String(row.payload)) as CaptureEvent),...pendingReports(output).filter(e=>e.observedAt>=lookback&&e.observedAt<to)];
  const decisions=db.prepare('SELECT start_event_id,end_event_id,mode,project_path FROM human_decisions').all().map(row=>({startEventId:String(row.start_event_id),endEventId:String(row.end_event_id),mode:row.mode,projectPath:row.project_path===null?null:String(row.project_path)})) as HumanDecision[];
  const splits=db.prepare('SELECT start_event_id,end_event_id,split_at,before_path,after_path FROM human_splits').all().map(row=>({startEventId:String(row.start_event_id),endEventId:String(row.end_event_id),splitAt:Number(row.split_at),beforePath:row.before_path===null?null:String(row.before_path),afterPath:row.after_path===null?null:String(row.after_path)})) as HumanSplit[];
  const settingsPath=join(output,'settings.json');let settings:Record<string,unknown>={};
  if(existsSync(settingsPath))try{settings=JSON.parse(readFileSync(settingsPath,'utf8'));}catch{/* Use collector defaults for invalid settings. */}
  const idle=Number(settings.humanIdleMinutes),agentIdle=Number(settings.agentIdleMinutes);
  const summary=applyHumanDecisions(summarize(events,{idleThreshold:Number.isFinite(idle)&&idle>0?idle*60:300,agentIdleThreshold:Number.isFinite(agentIdle)&&agentIdle>0?agentIdle*60:300}),decisions,splits);
  const clipped=summary.intervals.filter(i=>i.end>from&&i.start<to).map(i=>({...i,start:Math.max(from,i.start),end:Math.min(to,i.end)}));
  for(const interval of clipped)if(interval.state==='grouped'&&!interval.sourceEventIds.length){
   interval.sourceEventIds=[...new Set(summary.intervals.filter(source=>source.state!=='grouped'&&source.state!=='human'&&source.sessionId===interval.sessionId&&source.provider===interval.provider&&source.end>interval.start&&source.start<interval.end).flatMap(source=>source.sourceEventIds))].slice(0,32);
  }
  for(const interval of clipped)if(!interval.workspaceId&&interval.sessionId){
   const session=summary.sessions.find(s=>s.sessionId===interval.sessionId&&s.provider===interval.provider);
   if(session?.cwd)interval.workspaceId=`session::${projectPathFromWorktree(session.cwd)}`;
  }
  const truncatedBefore=Boolean(db.prepare('SELECT 1 AS found FROM events WHERE observed_at<? LIMIT 1').get(lookback));
  return {summary:{...summary,intervals:clipped},events,from,to,truncatedBefore};
 }finally{db.close();}
}
const projectOf=(i:Interval)=>i.workspaceId?.split('::').at(-1)||null;
const agentInterval=(i:Interval)=>!i.child&&i.state==='grouped';
const humanInterval=(i:Interval)=>i.state==='human';
const spans=(items:Interval[])=>items.map(i=>[i.start,i.end] as [number,number]);
const publicInterval=<T extends Interval>(i:T)=>{const {browserUrl,browserTitle,tabTitle,...safe}=i;return safe;};
function totals(items:Interval[]){
 const human=items.filter(humanInterval),agent=items.filter(agentInterval),bySession=new Map<string,Interval[]>();
 for(const interval of agent){const key=JSON.stringify([interval.hostId,interval.dispatchId||interval.sessionId]);const group=bySession.get(key)||[];group.push(interval);bySession.set(key,group);}
 return {humanActiveSeconds:minuteCreditSeconds(spans(human)),agentRunningSeconds:[...bySession.values()].reduce((sum,group)=>sum+minuteCreditSeconds(spans(group)),0),overlapMergedWallSeconds:minuteCreditSeconds(spans([...human,...agent]))};
}
function perDay(rows:ReturnType<typeof inRange>){
 const pieces:typeof rows=[];
 for(const row of rows){let cursor=row.start;while(cursor<row.end){const date=dateOf(cursor),next=new Date(dateStart(date)*1000);next.setDate(next.getDate()+1);const end=Math.min(row.end,next.getTime()/1000);pieces.push({...row,start:cursor,end});cursor=end;}}
 return [...new Set(pieces.map(i=>dateOf(i.start)))].sort().map(date=>({date,...totals(pieces.filter(i=>dateOf(i.start)===date))}));
}
function contextFor(i:Interval,events:CaptureEvent[]):CaptureEvent|null{
 if(!i.sessionId||!i.provider)return null;
 const contexts=events.filter(e=>e.source==='agent_report'&&e.kind==='work_context'&&e.provider===i.provider&&e.sessionId===i.sessionId&&e.observedAt<=i.start&&i.start-e.observedAt<=43200);
 return contexts.at(-1)||null;
}
function suggestedIssue(i:Interval,events:CaptureEvent[]):{issueKey:string;evidence:string[]}|null{
 if(i.state!=='human')return null;
 const project=projectOf(i);if(!project)return null;
 const candidates=events.filter(e=>e.source==='agent_report'&&e.kind==='work_context'&&e.data?.project===project&&typeof e.data?.issueKey==='string'&&e.observedAt<=i.end&&i.start-e.observedAt<=1800);
 const keys=[...new Set(candidates.map(e=>String(e.data?.issueKey)))];
 return keys.length===1?{issueKey:keys[0]!,evidence:candidates.filter(e=>e.data?.issueKey===keys[0]).map(e=>e.eventId)}:null;
}
function attribution(i:Interval,events:CaptureEvent[]){
 const context=contextFor(i,events),issueKey=context?.data?.issueKey;
 const observedProject=projectOf(i),reportedProject=typeof context?.data?.project==='string'?context.data.project:null;
 const suggestion=suggestedIssue(i,events);
 return {issueKey:typeof issueKey==='string'?issueKey:null,project:observedProject||reportedProject,
  suggestedIssueKey:suggestion?.issueKey||null,
  confidence:context&&reportedProject&&observedProject&&reportedProject!==observedProject?'conflict':i.userAttribution==='assigned'?'manual':observedProject?'observed-project':context?'agent-reported':'unattributed',
  evidence:context?[...i.sourceEventIds,context.eventId]:suggestion?[...i.sourceEventIds,...suggestion.evidence]:i.sourceEventIds};
}
const inRange=(s:Snapshot)=>s.summary.intervals.map(i=>({...i,...attribution(i,s.events)}));
export function timeForIssue(s:Snapshot,issueKey:string){
 if(!issuePattern.test(issueKey))throw new Error('Invalid Linear issue key');
 const rows=inRange(s).filter(i=>i.issueKey===issueKey);
 const suggestions=inRange(s).filter(i=>i.state==='human'&&i.suggestedIssueKey===issueKey);
 const days=perDay(rows);
 return {issueKey,...totals(rows),days,intervals:rows.slice(0,500).map(publicInterval),moreIntervals:rows.length>500,
  suggestedHumanSeconds:totals(suggestions).humanActiveSeconds,suggestedHumanIntervals:suggestions.slice(0,100).map(publicInterval),moreSuggestedHumanIntervals:suggestions.length>100,
  captureCoverage:coverage(s),attribution:'Agent-reported issue context is advisory; measured time is not a billing approval',truncatedBefore:s.truncatedBefore};
}
export function timeForProject(s:Snapshot,project:string){
 if(!project||project.length>512)throw new Error('Invalid project');
 const rows=inRange(s).filter(i=>i.project===project);
 const issues=[...new Set(rows.map(i=>i.issueKey||'Unmatched'))].sort().map(issueKey=>({issueKey,...totals(rows.filter(i=>(i.issueKey||'Unmatched')===issueKey))}));
 return {project,...totals(rows),issues,days:perDay(rows),captureCoverage:coverage(s),truncatedBefore:s.truncatedBefore};
}
export function timeline(s:Snapshot,project?:string){
 const rows=inRange(s).filter(i=>!project||i.project===project);
 return {intervals:rows.slice(0,500).map(publicInterval),moreIntervals:rows.length>500,totals:totals(rows),truncatedBefore:s.truncatedBefore};
}
export function sessions(s:Snapshot,filter:{provider?:string;workspace?:string;issueKey?:string}){
 const rows=s.summary.sessions.filter(session=>session.lastObservedAt>=s.from&&session.lastObservedAt<s.to&&
  (!filter.provider||session.provider===filter.provider)&&(!filter.workspace||session.workspaceId===filter.workspace));
 const filtered=filter.issueKey?rows.filter(session=>s.events.some(e=>e.source==='agent_report'&&e.kind==='work_context'&&e.provider===session.provider&&e.sessionId===session.sessionId&&e.data?.issueKey===filter.issueKey)):rows;
 return {sessions:filtered.slice(0,500).map(({title,cwd,...safe})=>safe),moreSessions:filtered.length>500};
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
 return {groups:groups.slice(0,500).map(g=>{
  const interval=s.summary.intervals.find(i=>i.state==='human'&&i.start>=g.start&&i.end<=g.end);
  return {start:g.start,end:g.end,seconds:g.seconds,label:interval?.browserDomain||interval?.foregroundName||interval?.foregroundBundleId||'Mac activity',projectPath:g.projectPath||null,reason:humanReviewState(g),eventIds:g.pairs.flat(),suggestedIssueKey:interval?suggestedIssue(interval,s.events)?.issueKey||null:null};
 }),moreGroups:groups.length>500};
}
export function explainAttribution(s:Snapshot,eventId:string){
 if(!uuidPattern.test(eventId))throw new Error('Invalid event ID');
 const interval=s.summary.intervals.find(i=>i.sourceEventIds.includes(eventId));
 if(!interval)return {eventId,found:false};
 return {eventId,found:true,interval:publicInterval({...interval,...attribution(interval,s.events)}),note:'Reported context is a suggestion; only observed intervals contribute measured time'};
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
