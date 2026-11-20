import type {Interval,Summary} from './events.ts';
import {groupIntervals,minuteCreditSeconds} from './correlate.ts';
import {agentSessionKey} from './session-identity.ts';

/** A user-removed time range of one agent execution (`executionKey` is an `agentSessionKey`). */
export interface AgentTimeExclusion {id:string;executionKey:string;date:string;start:number;end:number;createdAt:number;undoneAt?:number}
type Range=[number,number];
const ranges=(items:Interval[]):Range[]=>items.map(i=>[i.start,i.end]);

/** Remove `cuts` from `ranges`; the result is sorted and non-overlapping. */
export function subtractRanges(source:Range[],cuts:Range[]):Range[]{
 const sorted=[...cuts].filter(([s,e])=>e>s).sort((a,b)=>a[0]-b[0]),out:Range[]=[];
 for(const [start,end] of source){
  let cursor=start;
  for(const [s,e] of sorted){if(e<=cursor||s>=end)continue;if(s>cursor)out.push([cursor,s]);cursor=Math.max(cursor,e);}
  if(cursor<end)out.push([cursor,end]);
 }
 return out;
}

/** Cut excluded ranges out of agent intervals and lower the totals by the minute credit they carried. */
export function applyAgentExclusions(summary:Summary,exclusions:readonly AgentTimeExclusion[]):Summary{
 // A correction may name a session by its `key` (task-counter sessions use `task-counter:<id>`) or by its intervals' agentSessionKey.
 const alias=new Map<string,string>();for(const s of summary.sessions)if(s.key!==agentSessionKey(s))alias.set(s.key,agentSessionKey(s));
 const cuts=new Map<string,Range[]>();
 for(const x of exclusions)if(x.undoneAt===undefined&&x.end>x.start){const key=alias.get(x.executionKey)??x.executionKey;cuts.set(key,[...cuts.get(key)||[],[x.start,x.end]]);}
 if(!cuts.size)return summary;
 const hit=new Set<string>();
 const intervals:Interval[]=[];
 for(const interval of summary.intervals){
  const key=interval.state==='human'?undefined:agentSessionKey(interval),keyCuts=key&&cuts.get(key);
  if(!key||!keyCuts){intervals.push(interval);continue;}
  const parts=subtractRanges([[interval.start,interval.end]],keyCuts);
  if(parts.length===1&&parts[0]![0]===interval.start&&parts[0]![1]===interval.end){intervals.push(interval);continue;}
  hit.add(key);
  for(const [start,end] of parts)intervals.push({...interval,start,end});
 }
 if(!hit.size)return summary;
 // Credit mirrors dailyTotals: grouped intervals alone when present, else running/turn passed through groupIntervals.
 const hasGrouped=summary.intervals.some(i=>i.state==='grouped'),day=summary.mainAgentSeconds!==undefined;
 const activity=(items:Interval[])=>{
  const byKey=new Map<string,{child:boolean;ranges:Range[]}>();
  // Task-counter credit fills gaps beside grouped activity, so it counts alongside it.
  for(const i of items.filter(i=>hasGrouped?i.state==='grouped'||i.attributionSource==='task-counter':i.state==='running'||i.state==='turn')){
   const key=agentSessionKey(i),entry=byKey.get(key)||{child:Boolean(i.child),ranges:[]};entry.ranges.push([i.start,i.end]);byKey.set(key,entry);
  }
  return [...byKey].map(([key,{child,ranges}])=>({key,child,ranges:hasGrouped?ranges:groupIntervals(ranges)}));
 };
 const before=activity(summary.intervals),after=activity(intervals);
 const keyCredit=(list:ReturnType<typeof activity>,key:string)=>minuteCreditSeconds(list.filter(e=>e.key===key).flatMap(e=>e.ranges));
 let main=0,child=0;const sessionDelta=new Map<string,number>();
 for(const key of hit){
  const delta=keyCredit(before,key)-keyCredit(after,key);
  sessionDelta.set(key,delta);
  if(before.find(e=>e.key===key)?.child)child+=delta;else main+=delta;
 }
 const human=ranges(summary.intervals.filter(i=>i.state==='human'));
 const flat=(list:ReturnType<typeof activity>,includeChild:boolean)=>list.filter(e=>includeChild||!e.child).flatMap(e=>e.ranges);
 const wall=minuteCreditSeconds(flat(before,true))-minuteCreditSeconds(flat(after,true));
 // Day summaries count only main-session activity in clock time; raw replays include subagents.
 const elapsed=minuteCreditSeconds([...flat(before,!day),...human])-minuteCreditSeconds([...flat(after,!day),...human]);
 const lower=(value:number,delta:number)=>Math.max(0,value-delta);
 const result:Summary={...summary,intervals,
  sessions:summary.sessions.map(s=>{const delta=sessionDelta.get(s.key)??sessionDelta.get(agentSessionKey(s));return delta===undefined?s:{...s,seconds:lower(s.seconds,delta)};}),
  agentSeconds:lower(summary.agentSeconds,main+(summary.mainAgentSeconds!==undefined?child:0)),childAgentSeconds:lower(summary.childAgentSeconds,child),elapsedSeconds:lower(summary.elapsedSeconds,elapsed)};
 if(summary.mainAgentSeconds!==undefined)result.mainAgentSeconds=lower(summary.mainAgentSeconds,main);
 if(summary.agentWallSeconds!==undefined)result.agentWallSeconds=lower(summary.agentWallSeconds,wall);
 return result;
}
