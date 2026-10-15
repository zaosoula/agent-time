import test from 'node:test';
import assert from 'node:assert/strict';
import type {Interval,Session} from '../src/capture/events.ts';
import {indexSessionIntervals,sessionIntervalKey} from '../src/ui/session-intervals.ts';

const interval=(state:Interval['state'],extra:Partial<Interval>={}):Interval=>({start:1,end:2,state,proof:'observed',sourceEventIds:[],...extra});
const session=(extra:Partial<Session>={}):Session=>({key:'root',title:'Root',child:false,state:'idle',lastObservedAt:0,seconds:0,observedSeconds:0,proof:'observed',...extra});
const matches=(i:Interval,s:Session)=>s.child?Boolean(i.child&&i.sessionId===s.sessionId&&i.agentId===s.agentId):s.dispatchId?Boolean(i.dispatchId===s.dispatchId&&!i.child):Boolean(i.sessionId===s.sessionId&&!i.child&&!i.dispatchId);

test('indexed interval lookups preserve session, Dispatch, and subagent attribution',()=>{
 const intervals=[
  interval('grouped',{sessionId:'one'}),interval('running',{sessionId:'one'}),
  interval('grouped',{sessionId:'one',dispatchId:'run-1'}),
  interval('grouped',{sessionId:'one',agentId:'child-1',child:true}),
  interval('grouped',{sessionId:'one',agentId:'child-2',child:true}),
  interval('grouped',{sessionId:'one',child:true}),
  interval('waiting',{sessionId:'one'}),interval('grouped',{sessionId:'two'}),
 ];
 const sessions=[session({sessionId:'one'}),session({sessionId:'one',dispatchId:'run-1'}),session({sessionId:'one',agentId:'child-1',child:true}),session({sessionId:'one',child:true}),session({sessionId:'two'})];
 const index=indexSessionIntervals(intervals);
 for(const s of sessions){
  assert.deepEqual(index.grouped.get(sessionIntervalKey(s))||[],intervals.filter(i=>i.state==='grouped'&&matches(i,s)));
  assert.deepEqual(index.running.get(sessionIntervalKey(s))||[],intervals.filter(i=>i.state==='running'&&matches(i,s)));
 }
});
