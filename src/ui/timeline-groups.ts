import type {Interval,Session} from '../capture/events.ts';
import {minuteCreditSeconds} from '../capture/correlate.ts';

export interface ActivityChildRow {
 key:string;
 label:string;
 detail:string;
 intervals:Interval[];
 bars:Interval[];
 seconds:number;
}

// Collapse sampling boundaries for drawing only. A gap remains a gap, and
// aggregate rows only join spans carrying the same tooltip identity.
export function visualIntervals(intervals:Interval[],identity:(interval:Interval)=>string=()=>'',):Interval[]{
 const byIdentity=new Map<string,Interval[]>();
 for(const interval of intervals){
  const key=identity(interval),group=byIdentity.get(key)||[];
  group.push(interval);byIdentity.set(key,group);
 }
 const result:Interval[]=[];
 for(const group of byIdentity.values())for(const interval of group.sort((a,b)=>a.start-b.start||a.end-b.end)){
  const last=result.at(-1);
  if(last&&identity(last)===identity(interval)&&interval.start<=last.end)last.end=Math.max(last.end,interval.end);
  else result.push({...interval});
 }
 return result.sort((a,b)=>a.start-b.start||a.end-b.end);
}

// The timesheet rounds each distinct, already-grouped activity block up to a
// minute. Keep the observed spans separately for evidence and concurrency.
export function creditedIntervals(intervals:Interval[],identity:(interval:Interval)=>string=()=>''):Interval[]{
 return visualIntervals(intervals,identity).map(interval=>({
  ...interval,end:interval.start+Math.ceil((interval.end-interval.start)/60)*60,
 }));
}

export interface AgentLoadSegment {
 start:number;
 end:number;
 roots:number;
 children:number;
 total:number;
}

// Count simultaneously active agent sessions from their bounded evidence spans.
// Adjacent equal-height steps are combined to keep the project chart compact.
export function agentLoadSegments(roots:Interval[],children:Interval[]):AgentLoadSegment[] {
 const changes=new Map<number,{roots:number;children:number}>();
 const add=(time:number,rootDelta:number,childDelta:number)=>{
  const current=changes.get(time)||{roots:0,children:0};
  current.roots+=rootDelta;current.children+=childDelta;changes.set(time,current);
 };
 for(const [intervals,child] of [[roots,false],[children,true]] as const)for(const interval of intervals){
  if(interval.end<=interval.start)continue;
  add(interval.start,child?0:1,child?1:0);
  add(interval.end,child?0:-1,child?-1:0);
 }
 const result:AgentLoadSegment[]=[];
 let rootsNow=0,childrenNow=0,previous:number|undefined;
 for(const [time,change] of [...changes].sort((a,b)=>a[0]-b[0])){
  if(previous!==undefined&&time>previous&&rootsNow+childrenNow>0){
   const last=result.at(-1);
   if(last&&last.end===previous&&last.roots===rootsNow&&last.children===childrenNow)last.end=time;
   else result.push({start:previous,end:time,roots:rootsNow,children:childrenNow,total:rootsNow+childrenNow});
  }
  rootsNow+=change.roots;childrenNow+=change.children;previous=time;
 }
 return result;
}

export interface TimelineProjectGroup {
 name:string;
 sessions:Session[];
 human:Interval[];
 mac:Interval[];
 browser:Interval[];
 humanBars:Interval[];
 macBars:Interval[];
 browserBars:Interval[];
 creditBars:Interval[];
 agent:Interval[];
 subagent:Interval[];
 humanSeconds:number;
 macSeconds:number;
 browserSeconds:number;
 agentSeconds:number;
 macApps:ActivityChildRow[];
 websites:ActivityChildRow[];
 load:AgentLoadSegment[];
 peakConcurrent:number;
}

function browserSite(interval:Interval):string {
 if(interval.browserOrigin){
  try {
   const url=new URL(interval.browserOrigin);
   if(['localhost','127.0.0.1','::1'].includes(url.hostname)||url.hostname.endsWith('.localhost'))return url.host;
  } catch { /* Keep the captured domain when an origin is malformed. */ }
 }
 return interval.browserDomain||'Unknown website';
}

function childRows(intervals:Interval[],identity:(interval:Interval)=>string,label:(interval:Interval)=>string,detail:(group:Interval[])=>string):ActivityChildRow[] {
 const rows=new Map<string,ActivityChildRow>();
 for(const interval of intervals){
  const key=identity(interval),row=rows.get(key)||{key,label:label(interval),detail:'',intervals:[],bars:[],seconds:0};
  row.intervals.push(interval);
  rows.set(key,row);
 }
 return [...rows.values()].map(row=>({
  ...row,bars:creditedIntervals(row.intervals),detail:detail(row.intervals),seconds:minuteCreditSeconds(row.intervals.map(i=>[i.start,i.end])),
 })).sort((a,b)=>b.seconds-a.seconds||a.label.localeCompare(b.label));
}

export function groupTimelineProjects(
 sessions:Session[],humanIntervals:Interval[],humanBySession:Map<string,Interval[]>,
 bars:(session:Session)=>Interval[],projectName:(session:Session)=>string,
 projectFromWorkspace:(workspaceId:string)=>string,includeHumanOnly=true,
):TimelineProjectGroup[]{
 const groups=new Map<string,TimelineProjectGroup>();
 const get=(name:string)=>{
  let group=groups.get(name);
  if(!group){group={name,sessions:[],human:[],mac:[],browser:[],humanBars:[],macBars:[],browserBars:[],creditBars:[],agent:[],subagent:[],humanSeconds:0,macSeconds:0,browserSeconds:0,agentSeconds:0,macApps:[],websites:[],load:[],peakConcurrent:0};groups.set(name,group);}
  return group;
 };
 const addHuman=(group:TimelineProjectGroup,interval:Interval)=>{
  group.human.push(interval);
  (interval.browserDomain?group.browser:group.mac).push(interval);
 };
 for(const session of sessions)get(projectName(session)).sessions.push(session);
 for(const interval of humanIntervals){
  if(interval.state!=='human'||!interval.workspaceId)continue;
  const name=projectFromWorkspace(interval.workspaceId);
  if(name==='Unassigned'||!includeHumanOnly&&!groups.has(name))continue;
  addHuman(get(name),interval);
 }
 for(const group of groups.values()){
  for(const session of group.sessions){
   const observed=bars(session);
   group.creditBars.push(...creditedIntervals(observed));
   if(session.child)group.subagent.push(...observed);
   else{
    group.agent.push(...observed);group.agentSeconds+=session.seconds;
    for(const interval of (humanBySession.get(session.key)||[]).filter(i=>!i.workspaceId))addHuman(group,interval);
   }
  }
  group.humanSeconds=minuteCreditSeconds(group.human.map(i=>[i.start,i.end]));
  group.macSeconds=minuteCreditSeconds(group.mac.map(i=>[i.start,i.end]));
  group.browserSeconds=minuteCreditSeconds(group.browser.map(i=>[i.start,i.end]));
  group.creditBars=visualIntervals(group.creditBars);
  group.humanBars=creditedIntervals(group.human);
  group.macBars=creditedIntervals(group.mac,i=>i.foregroundBundleId||i.foregroundName||'Unknown app');
  group.browserBars=creditedIntervals(group.browser,i=>JSON.stringify([i.browserUrl,i.browserTitle,i.browserDomain]));
  group.load=agentLoadSegments(group.agent,group.subagent);
  group.peakConcurrent=group.load.reduce((peak,segment)=>Math.max(peak,segment.total),0);
  group.macApps=childRows(group.mac,i=>i.foregroundBundleId||i.foregroundName||'unknown-app',i=>i.foregroundName||i.foregroundBundleId||'Unknown app',intervals=>intervals[0]?.foregroundBundleId||'Foreground app');
  group.websites=childRows(group.browser,browserSite,browserSite,intervals=>{
   const pages=new Set(intervals.map(i=>i.browserUrl).filter(Boolean));
   const browsers=new Set(intervals.map(i=>i.foregroundName).filter(Boolean));
   return [browsers.size?[...browsers].join(', '):'Browser',pages.size?`${pages.size} ${pages.size===1?'page':'pages'}`:undefined].filter(Boolean).join(' · ');
  });
 }
 return [...groups.values()];
}
