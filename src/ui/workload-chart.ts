import type {AgentLoadSegment} from './timeline-groups.ts';

export const workloadChartWidth=1000;
export const workloadChartHeight=56;

// A shared scale keeps a one-agent span shorter than a busy project, even
// when the projects have different daily peaks. Log spacing leaves one agent
// visible while preserving room for large dispatches.
export function workloadHeight(count:number):number {
 return Math.min(47,10+Math.round(Math.log2(Math.max(1,count))*8));
}

export function workloadAreaPath(segments:AgentLoadSegment[],start:number,span:number):string {
 if(span<=0)return '';
 const x=(time:number)=>Number(((time-start)/span*workloadChartWidth).toFixed(3));
 const parts:string[]=[];
 let lastEnd:number|undefined;
 for(const segment of segments){
  const from=Math.max(start,segment.start),to=Math.min(start+span,segment.end);
  if(to<=from||segment.total<=0)continue;
  const left=x(from),right=x(to),top=workloadChartHeight-workloadHeight(segment.total);
  if(right<=left)continue;
  if(lastEnd===left)parts.push(`H${left}V${top}`);
  else {
   if(lastEnd!==undefined)parts.push(`V${workloadChartHeight}Z`);
   parts.push(`M${left} ${workloadChartHeight}V${top}`);
  }
  parts.push(`H${right}`);
  lastEnd=right;
 }
 if(lastEnd!==undefined)parts.push(`V${workloadChartHeight}Z`);
 return parts.join('');
}
