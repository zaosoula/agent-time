import type { Summary } from './events.ts';
import { unionSeconds } from './correlate.ts';
export function dailyTotals(summary:Summary,now=new Date()){
 const start=new Date(now);start.setHours(0,0,0,0);const end=new Date(start);end.setDate(end.getDate()+1);
 const intervals=summary.intervals.filter(i=>i.end>start.getTime()/1000&&i.start<end.getTime()/1000).map(i=>({...i,start:Math.max(i.start,start.getTime()/1000),end:Math.min(i.end,end.getTime()/1000)}));
 const roots=new Map<string,Array<[number,number]>>();
 for(const i of intervals.filter(i=>i.state==='running'&&!i.child)){
  const key=`${i.hostId}:${i.dispatchId?'dispatch:'+i.dispatchId:'session:'+i.sessionId}`;
  const ranges=roots.get(key)||[];ranges.push([i.start,i.end]);roots.set(key,ranges);
 }
 return {agentSeconds:[...roots.values()].reduce((sum,r)=>sum+unionSeconds(r),0),humanSeconds:unionSeconds(intervals.filter(i=>i.state==='human').map(i=>[i.start,i.end])),elapsedSeconds:unionSeconds(intervals.filter(i=>i.state!=='waiting').map(i=>[i.start,i.end]))};
}
