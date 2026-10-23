import test from 'node:test';
import assert from 'node:assert/strict';
import {clampTimeRange,initialTimelineRange,panTimeRange,timelineTicks,zoomTimeRange} from '../src/ui/timeline-viewport.ts';

const day=24*3600;
test('pointer-centered zoom keeps the pointed time in place',()=>{
 assert.deepEqual(zoomTimeRange({start:0,end:8*3600},2*3600,.5,0,day),{start:3600,end:5*3600});
 assert.deepEqual(zoomTimeRange({start:0,end:3600},0,.01,0,day),{start:0,end:60});
});
test('range handles and panning stay inside the day',()=>{
 assert.deepEqual(clampTimeRange({start:day-30,end:day+30},0,day),{start:day-60,end:day});
 assert.deepEqual(panTimeRange({start:3600,end:7200},-7200,0,day),{start:0,end:3600});
 assert.deepEqual(panTimeRange({start:3600,end:7200},day,0,day),{start:day-3600,end:day});
});
test('initial range includes late activity on 25-hour days and fits 23-hour days',()=>{
 assert.deepEqual(initialTimelineRange(0,25*3600,[{start:23*3600,end:24.5*3600}],0,false),{start:19*3600,end:25*3600});
 const short=initialTimelineRange(0,23*3600,[],22*3600,true);
 assert.ok(short.start>=0&&short.end<=23*3600);
 assert.ok(short.end>=22*3600);
});
test('tick spacing becomes finer as the timeline zooms',()=>{
 const quarterHour=timelineTicks({start:0,end:900});
 assert.equal(quarterHour.length,61);
 assert.deepEqual(quarterHour.filter(tick=>tick.major).map(tick=>tick.time),Array.from({length:16},(_,minute)=>minute*60));
 const minute=timelineTicks({start:0,end:60});
 assert.equal(minute.length,31);
 assert.deepEqual(minute.filter(tick=>tick.major).map(tick=>tick.time),[0,10,20,30,40,50,60]);
 assert.equal(timelineTicks({start:0,end:day}).filter(tick=>tick.major).length,13);
});
