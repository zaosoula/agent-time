import { shallowRef } from 'vue';
import type { AppReviewGroup } from './review-apps.ts';
import { reviewGroupId } from './review-apps.ts';

export const reviewDrag = shallowRef<{token:string;date:string;ids:string[];seconds:number} | null>(null);
export const reviewDrop = shallowRef<{date:string;ids:string[];project:string|null;sequence:number} | null>(null);
let sequence=0;
export const reviewDragType='application/x-agent-time-review';
export function beginReviewDrag(date:string,groups:AppReviewGroup[],transfer:DataTransfer) {
  const token=crypto.randomUUID();
  reviewDrag.value={token,date,ids:groups.map(reviewGroupId),seconds:groups.reduce((sum,g)=>sum+g.seconds,0)};
  transfer.effectAllowed='move';transfer.setData(reviewDragType,token);
  transfer.setData('text/plain',`Assign ${groups.length} activity visits`);
}
export function dropReviewActivity(date:string,project:string|null,transfer:DataTransfer) {
  const drag=reviewDrag.value;
  if(!drag||drag.date!==date||transfer.getData(reviewDragType)!==drag.token)return false;
  reviewDrop.value={date,ids:drag.ids,project,sequence:++sequence};reviewDrag.value=null;return true;
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
