import { shallowRef } from 'vue';
import type { AppReviewGroup } from './review-apps.ts';
import { reviewGroupId } from './review-apps.ts';

export const reviewDrag = shallowRef<{token:string;date:string;ids:string[];seconds:number;groups?:AppReviewGroup[]} | null>(null);
export const reviewDrop = shallowRef<{date:string;ids:string[];project:string|null;sequence:number;groups?:AppReviewGroup[]} | null>(null);
let sequence=0;
export const reviewDragType='application/x-agent-time-review';
export function beginReviewDrag(date:string,groups:AppReviewGroup[],transfer:DataTransfer) {
  const token=crypto.randomUUID();
  reviewDrag.value={token,date,ids:groups.map(reviewGroupId),seconds:groups.reduce((sum,g)=>sum+g.seconds,0),groups:groups.map(g=>({...g,pairs:g.pairs.map(pair=>[...pair] as [string,string])}))};
  transfer.effectAllowed='move';transfer.setData(reviewDragType,token);
  transfer.setData('text/plain',`Assign ${groups.length} activity visits`);
}
export function canAcceptReviewDrop(date:string,transfer:Pick<DataTransfer,'types'>|null){
  return Boolean(reviewDrag.value&&reviewDrag.value.date===date&&transfer?.types.includes(reviewDragType));
}
export function dropReviewActivity(date:string,project:string|null,transfer:DataTransfer) {
  const drag=reviewDrag.value;
  if(!drag||drag.date!==date||transfer.getData(reviewDragType)!==drag.token)return false;
  reviewDrop.value={date,ids:drag.ids,project,sequence:++sequence,groups:drag.groups};reviewDrag.value=null;return true;
}
export function reviewAssignmentParts(groups:AppReviewGroup[]) {
  const pairs=new Map<string,[string,string]>(),segments=new Map<string,{pair:[string,string];segment:'before'|'after'}>();
  for(const group of groups)for(const pair of group.pairs){
    const key=JSON.stringify(pair);
    if(group.reviewSegment)segments.set(`${key}:${group.reviewSegment}`,{pair,segment:group.reviewSegment});
    else pairs.set(key,pair);
  }
  return {pairs:[...pairs.values()],segments:[...segments.values()].filter(s=>!pairs.has(JSON.stringify(s.pair)))};
}

/** All entry points submit the exact same recorded pairs/segments, scoped to their originating day. */
export async function assignReviewActivity<T>(groups:AppReviewGroup[],project:string|null,date:string,save:(pairs:Array<[string,string]>,mode:'assigned'|'unassigned',projectPath?:string,date?:string,segments?:Array<{pair:[string,string];segment:'before'|'after'}>)=>Promise<T>):Promise<T>{
 const parts=reviewAssignmentParts(groups);
 if(!groups.length||!parts.pairs.length&&!parts.segments.length)throw new Error('Select recorded activity first.');
 if(parts.pairs.length+parts.segments.length>10000)throw new Error('This selection is too large. Select at most 10,000 recorded intervals.');
 return save(parts.pairs,project?'assigned':'unassigned',project||undefined,date,parts.segments.length?parts.segments:undefined);
}
export type ReviewParts=ReturnType<typeof reviewAssignmentParts>;
export const reviewFocus = shallowRef<{date:string;ids:string[];sequence:number;parts?:ReviewParts}|null>(null);
export function requestReviewFocus(date:string,ids:string[]=[],groups?:AppReviewGroup[]){
 const parts=groups?reviewAssignmentParts(groups):undefined;
 reviewFocus.value={date,ids:[...ids],sequence:++sequence,...(parts?{parts:{pairs:parts.pairs.map(pair=>[...pair] as [string,string]),segments:parts.segments.map(item=>({...item,pair:[...item.pair] as [string,string]}))}}:{})};
}
export function reviewPartKeys(parts:ReviewParts){return new Set([...parts.pairs.map(pair=>JSON.stringify([...pair,''])),...parts.segments.map(item=>JSON.stringify([...item.pair,item.segment]))]);}
export function reviewSelectionIsCurrent(groups:AppReviewGroup[],current:AppReviewGroup[]){
 const available=reviewPartKeys(reviewAssignmentParts(current));
 return [...reviewPartKeys(reviewAssignmentParts(groups))].every(key=>available.has(key));
}
