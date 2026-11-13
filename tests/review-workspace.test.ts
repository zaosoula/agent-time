import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildAppReviewGroups} from '../src/ui/review-apps.ts';
import {reviewAssignmentParts,beginReviewDrag,dropReviewActivity,reviewDrag,reviewDrop,reviewDragType} from '../src/ui/review-workspace.ts';
const group=(segment?:'before'|'after')=>buildAppReviewGroups([{start:0,end:20,state:'human',proof:'observed',sourceEventIds:['a','b'],hostId:'local',foregroundName:'Editor',reviewSegment:segment}])[0]!;
test('assignment deduplicates ancestors and preserves selected split halves',()=>{
 const before=group('before'),after=group('after');
 assert.deepEqual(reviewAssignmentParts([before,before]),{pairs:[],segments:[{pair:['a','b'],segment:'before'}]});
 assert.equal(reviewAssignmentParts([before,after]).segments.length,2);
 assert.deepEqual(reviewAssignmentParts([before,after,group()]),{pairs:[['a','b']],segments:[]});
});
test('drag rejects external tokens and stale dates without issuing assignment',()=>{
 const data=new Map<string,string>();const transfer={setData:(k:string,v:string)=>data.set(k,v),getData:(k:string)=>data.get(k)||'',effectAllowed:''} as unknown as DataTransfer;
 beginReviewDrag('2026-11-13',[group()],transfer);
 assert.equal(dropReviewActivity('2026-11-12','/project',transfer),false);
 const token=data.get(reviewDragType)!;data.set(reviewDragType,'external');
 assert.equal(dropReviewActivity('2026-11-13','/project',transfer),false);
 data.set(reviewDragType,token);assert.equal(dropReviewActivity('2026-11-13','/project',transfer),true);
 assert.equal(reviewDrop.value?.project,'/project');assert.equal(reviewDrop.value?.ids.length,1);assert.equal(reviewDrag.value,null);
 assert.equal(dropReviewActivity('2026-11-13','/other',transfer),false);
 assert.equal(data.get('text/plain'),'Assign 1 activity visits');
});
