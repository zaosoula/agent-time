import type {Interval} from '../capture/events.ts';
import {agentSessionKey} from '../capture/session-identity.ts';
type Span={start:number;end:number};
class MinuteBlocks {
 private credited=0;private open:{start:number;end:number;selectedSeconds:number;selectedEnd:number}|undefined;
 private settle(){if(this.open){const duration=this.open.end-this.open.start;this.credited+=Math.ceil(duration/60)*60*(this.open.selectedSeconds/duration);}}
 add(ranges:Span[],selected:Span[]=ranges){
  const selections=selected.filter(r=>r.end>r.start).sort((a,b)=>a.start-b.start||a.end-b.end);
  for(const range of ranges.filter(r=>r.end>r.start).sort((a,b)=>a.start-b.start||a.end-b.end)){
   if(!Number.isFinite(range.start)||!Number.isFinite(range.end))throw new Error('Invalid measured time interval');
   if(this.open&&range.start<=this.open.end)this.open.end=Math.max(this.open.end,range.end);
   else {this.settle();this.open={start:range.start,end:range.end,selectedSeconds:0,selectedEnd:range.start};}
   for(const selection of selections){const start=Math.max(range.start,selection.start,this.open.selectedEnd),end=Math.min(range.end,selection.end);if(end>start){this.open.selectedSeconds+=end-start;this.open.selectedEnd=end;}}
  }
 }
 get end(){return this.open?.end??-Infinity;}
 get seconds(){const open=this.open;return this.credited+(open?Math.ceil((open.end-open.start)/60)*60*(open.selectedSeconds/(open.end-open.start)):0);}
}
/** One open block per boundary-crossing execution. Filtered metadata receives its share of the original block credit. */
export class PeriodTimeCredits {
 private human=new MinuteBlocks();private wall=new MinuteBlocks();private combined=new MinuteBlocks();
 private agents=new Map<string,MinuteBlocks>();private settledAgentSeconds=0;
 add(rows:Interval[],dayEnd:number,measuredRows:Interval[]=rows){
  const human=rows.filter(i=>i.state==='human'),agent=rows.filter(i=>i.state==='grouped'||i.attributionSource==='task-counter'&&i.state==='running');
  const allHuman=measuredRows.filter(i=>i.state==='human'),allAgent=measuredRows.filter(i=>i.state==='grouped'||i.attributionSource==='task-counter'&&i.state==='running');
  this.human.add(allHuman,human);this.wall.add(allAgent,agent);this.combined.add([...allHuman,...allAgent],[...human,...agent]);
  const groups=new Map<string,Interval[]>(),selected=new Map<string,Interval[]>();
  for(const interval of allAgent){const key=agentSessionKey(interval),group=groups.get(key)||[];group.push(interval);groups.set(key,group);}
  for(const interval of agent){const key=agentSessionKey(interval),group=selected.get(key)||[];group.push(interval);selected.set(key,group);}
  for(const [key,intervals] of groups){const credit=this.agents.get(key)||new MinuteBlocks();credit.add(intervals,selected.get(key)||[]);this.agents.set(key,credit);}
  for(const [key,credit] of this.agents)if(credit.end<dayEnd){this.settledAgentSeconds+=credit.seconds;this.agents.delete(key);}
 }
 totals(){return {humanActiveSeconds:this.human.seconds,agentRunningSeconds:this.settledAgentSeconds+[...this.agents.values()].reduce((sum,item)=>sum+item.seconds,0),agentWallSeconds:this.wall.seconds,overlapMergedWallSeconds:this.combined.seconds};}
}
