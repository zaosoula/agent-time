import type {AppReviewGroup} from './review-apps.ts';
import type {AgentExecution} from './project-explorer.ts';
import type {BillingReport} from '../capture/billing-types.ts';
export type ActivityDetailTarget =
 | {kind:'human';date:string;groups:AppReviewGroup[]}
 | {kind:'agent';date:string;execution:AgentExecution}
 | {kind:'billing';report:Omit<BillingReport,'projectSnapshot'>};
/** Original spans only. A first/last envelope would include unobserved gaps. */
export function activityDetailSpans(target:ActivityDetailTarget){
 if(target.kind==='billing')return [];
 return (target.kind==='human'?target.groups:target.execution.bars).map(item=>({start:item.start,end:item.end}));
}
type Range={start:number;end:number};
/** Ranges to exclude so that only `next` remains of `span`: the head before it and the tail after it. */
export function trimCuts(span:Range,next:Range):Array<[number,number]>{
 if(!(next.end>next.start)||next.start<span.start||next.end>span.end)throw new Error('Keep the new times inside the original interval');
 const cuts:Array<[number,number]>=[];
 if(next.start>span.start)cuts.push([span.start,next.start]);
 if(next.end<span.end)cuts.push([next.end,span.end]);
 return cuts;
}
/** `HH:MM:SS` for a time input, in local time. */
export function timeInputValue(seconds:number){const d=new Date(seconds*1000),p=(n:number)=>String(n).padStart(2,'0');return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;}
/**
 * Epoch seconds for a time input value, moved from `original` by the shortest
 * wall-clock change. Working from the edge itself keeps a repeated or skipped
 * DST hour and an end at midnight on the right side; an unchanged field keeps
 * `original`, so sub-second edges survive.
 */
export function timeInputSeconds(value:string,original:number){
 if(value===timeInputValue(original))return original;
 const parts=/^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);if(!parts)throw new Error('Enter a valid time');
 const wall=(text:string)=>{const [h,m,s=0]=text.split(':').map(Number);return h!*3600+m!*60+s;};
 const target=Number(parts[1])*3600+Number(parts[2])*60+Number(parts[3]||0),shift=(target-wall(timeInputValue(Math.floor(original)))+86400)%86400;
 const base=Math.floor(original)+(shift>43200?shift-86400:shift),wanted=`${parts[1]}:${parts[2]}:${parts[3]||'00'}`;
 // A DST change between the edge and the new time moves the wall clock by an hour.
 for(const candidate of [base,base-3600,base+3600])if(timeInputValue(candidate)===wanted)return candidate;
 throw new Error('That time does not exist on this day');
}
