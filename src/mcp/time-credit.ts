import type {Interval} from '../capture/events.ts';
import {agentSessionKey} from '../capture/session-identity.ts';

class MinuteBlocks {
 private credited=0;private open:{start:number;end:number}|undefined;
 add(ranges:Array<{start:number;end:number}>){
  for(const range of ranges.filter(r=>r.end>r.start).sort((a,b)=>a.start-b.start||a.end-b.end)){
   if(!Number.isFinite(range.start)||!Number.isFinite(range.end))throw new Error('Invalid measured time interval');
   if(this.open&&range.start<=this.open.end)this.open.end=Math.max(this.open.end,range.end);
   else {if(this.open)this.credited+=Math.ceil((this.open.end-this.open.start)/60)*60;this.open={start:range.start,end:range.end};}
  }
 }
 get end(){return this.open?.end??-Infinity;}
 get seconds(){return this.credited+(this.open?Math.ceil((this.open.end-this.open.start)/60)*60:0);}
}
/** One open block per boundary-crossing execution, rather than an entire period of raw intervals. */
export class PeriodTimeCredits {
 private human=new MinuteBlocks();private wall=new MinuteBlocks();private combined=new MinuteBlocks();
 private agents=new Map<string,MinuteBlocks>();private settledAgentSeconds=0;
 add(rows:Interval[],dayEnd:number){
  const human=rows.filter(i=>i.state==='human'),agent=rows.filter(i=>i.state==='grouped'||i.attributionSource==='task-counter'&&i.state==='running');
  this.human.add(human);this.wall.add(agent);this.combined.add([...human,...agent]);
  const groups=new Map<string,Interval[]>();for(const interval of agent){const key=agentSessionKey(interval),group=groups.get(key)||[];group.push(interval);groups.set(key,group);}
  for(const [key,intervals] of groups){const credit=this.agents.get(key)||new MinuteBlocks();credit.add(intervals);this.agents.set(key,credit);}
  // An execution ending before this boundary cannot overlap an interval in a later day.
  for(const [key,credit] of this.agents)if(credit.end<dayEnd){this.settledAgentSeconds+=credit.seconds;this.agents.delete(key);}
 }
 totals(){return {humanActiveSeconds:this.human.seconds,agentRunningSeconds:this.settledAgentSeconds+[...this.agents.values()].reduce((sum,item)=>sum+item.seconds,0),agentWallSeconds:this.wall.seconds,overlapMergedWallSeconds:this.combined.seconds};}
}
