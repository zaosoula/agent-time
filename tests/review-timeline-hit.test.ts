import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reviewTimelineHit} from '../src/ui/review-timeline-hit.ts';

test('timeline hit tests exact half-open spans, including narrow observations and empty gaps',()=>{
 const spans=[{start:10,end:20},{start:20,end:20.01},{start:30,end:40}];
 assert.equal(reviewTimelineHit(spans,9),-1);
 assert.equal(reviewTimelineHit(spans,10),0);
 assert.equal(reviewTimelineHit(spans,19.999),0);
 assert.equal(reviewTimelineHit(spans,20),1);
 assert.equal(reviewTimelineHit(spans,20.005),1);
 assert.equal(reviewTimelineHit(spans,20.01),-1);
 assert.equal(reviewTimelineHit(spans,25),-1);
 assert.equal(reviewTimelineHit(spans,30),2);
 assert.equal(reviewTimelineHit(spans,40),-1);
 assert.equal(reviewTimelineHit([],30),-1);
 assert.equal(reviewTimelineHit(spans,NaN),-1);
});

test('overlapping timeline observations pick the final visible span',()=>{
 assert.equal(reviewTimelineHit([{start:0,end:20},{start:10,end:15}],12),1);
 assert.equal(reviewTimelineHit([{start:0,end:20},{start:10,end:15}],15),0);
});
