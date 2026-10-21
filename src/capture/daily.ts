import type { Issue, Summary } from './events.ts';
import { groupIntervals, minuteCreditSeconds } from './correlate.ts';
import { staticOrcaScopeReason } from './observation-retention.ts';
export function dailyCaptureIssues(summary:Summary,from:number,to:number):Issue[] {
 return [...summary.coverage,...summary.unresolved].filter(issue=>issue.observedAt!==undefined&&issue.observedAt>=from&&issue.observedAt<to&&issue.reason!==staticOrcaScopeReason);
}
export function dailyTotals(summary:Summary,now=new Date()){
 const start=new Date(now);start.setHours(0,0,0,0);const end=new Date(start);end.setDate(end.getDate()+1);
 const intervals=summary.intervals.filter(i=>i.end>start.getTime()/1000&&i.start<end.getTime()/1000).map(i=>({...i,start:Math.max(i.start,start.getTime()/1000),end:Math.min(i.end,end.getTime()/1000)}));
 const hasGrouped=intervals.some(i=>i.state==='grouped');
 const activity=intervals.filter(i=>hasGrouped?i.state==='grouped':i.state==='running'||i.state==='turn');
 const roots=new Map<string,Array<[number,number]>>();
 for(const i of activity.filter(i=>!i.child)){
  const key=`${i.hostId}:${i.dispatchId?'dispatch:'+i.dispatchId:'session:'+i.sessionId}`;
  const ranges=roots.get(key)||[];ranges.push([i.start,i.end]);roots.set(key,ranges);
 }
 const agentSeconds=[...roots.values()].reduce((sum,r)=>sum+minuteCreditSeconds(hasGrouped?r:groupIntervals(r)),0);
 const elapsed=hasGrouped?activity.map(i=>[i.start,i.end] as [number,number]):[...roots.values()].flatMap(r=>groupIntervals(r));
 const human=intervals.filter(i=>i.state==='human').map(i=>[i.start,i.end] as [number,number]);
 return {agentSeconds,humanSeconds:minuteCreditSeconds(human),elapsedSeconds:minuteCreditSeconds([...elapsed,...human])};
}
export function workingAgentCount(summary:Summary,now=new Date(),running=true):number {
 if(!running)return 0;
 return summary.sessions.filter(session=>session.seconds>0&&['working','running'].includes(session.state)&&now.getTime()/1000-session.lastObservedAt<20).length;
}

export function summaryForDate(summary:Summary,date:string):Summary {
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new Error('Invalid summary date');
 const start=new Date(`${date}T00:00:00`);
 if(Number.isNaN(start.getTime())||`${start.getFullYear()}-${String(start.getMonth()+1).padStart(2,'0')}-${String(start.getDate()).padStart(2,'0')}`!==date)throw new Error('Invalid summary date');
 const end=new Date(start);end.setDate(end.getDate()+1);
 const from=start.getTime()/1000,to=end.getTime()/1000;
 const intervals=summary.intervals.filter(i=>i.end>from&&i.start<to).map(i=>({...i,start:Math.max(i.start,from),end:Math.min(i.end,to)}));
 const day={...summary,intervals};
 const children=new Map<string,Array<[number,number]>>();
 for(const interval of intervals.filter(i=>i.child&&i.state==='grouped')){
  const key=JSON.stringify([interval.hostId,interval.sessionId,interval.agentId]);
  const spans=children.get(key)||[];spans.push([interval.start,interval.end]);children.set(key,spans);
 }
 return {...day,...dailyTotals(day,start),childAgentSeconds:[...children.values()].reduce((total,spans)=>total+minuteCreditSeconds(spans),0)};
}
