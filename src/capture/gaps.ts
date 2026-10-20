import type {Interval} from './events.ts';
export interface UnobservedGap {start:number;end:number;seconds:number;}
export function unobservedGaps(intervals:Interval[],minimumSeconds=300):UnobservedGap[]{
 const spans=intervals.filter(interval=>['human','grouped'].includes(interval.state)&&interval.end>interval.start).map(interval=>[interval.start,interval.end] as [number,number]).sort((a,b)=>a[0]-b[0]);
 if(spans.length<2)return [];
 const merged:[number,number][]=[];
 for(const [start,end] of spans){const last=merged.at(-1);if(last&&start<=last[1])last[1]=Math.max(last[1],end);else merged.push([start,end]);}
 return merged.slice(1).map(([start],index)=>({start:merged[index][1],end:start,seconds:start-merged[index][1]})).filter(gap=>gap.seconds>=minimumSeconds);
}
