import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Collector} from '../src/capture/collector.ts';
import {makeEvent} from '../src/capture/events.ts';
import {EventStore} from '../src/capture/store.ts';
import {dispatchRequest} from '../src/capture/protocol.ts';
import type {HumanDecisionSegment} from '../src/capture/human-review.ts';

const pair:[string,string]=['review-start','review-end'];
const before:HumanDecisionSegment={pair,segment:'before'},after:HumanDecisionSegment={pair,segment:'after'};

test('mixed hierarchical assignment preserves the other split half, persists, and undoes one complete action',async()=>{
 const output=mkdtempSync(join(tmpdir(),'agent-time-segment-review-'));
 let collector=new Collector(output);
 try{
  const date='2026-11-10',at=new Date(`${date}T10:00:00`).getTime()/1000;
  for(const [index,id] of [...pair,'review-third'].entries())collector.store.put(makeEvent('macos','activity',{eventId:id,observedAt:at+index*10,monotonicAt:index*10,data:{idleSeconds:0}}));
  collector.setHumanGroupSplit([pair],at+4,output);
  const original=collector.store.humanSplits(),observations=collector.store.events();
  const whole:[string,string]=[pair[1],'review-third'];
  const baseline=collector.reviewHistory().length;
  assert.throws(()=>collector.setHumanDecision([pair],'assigned',tmpdir(),date,[{pair:whole,segment:'before'}]),/Activity changed/);
  assert.deepEqual(collector.store.humanSplits(),original);assert.equal(collector.reviewHistory().length,baseline);
  const result=collector.setHumanDecision([whole,whole],'assigned',tmpdir(),date,[before,before]);
  const parts=result.intervals.filter(interval=>interval.sourceEventIds[0]===pair[0]);
  assert.equal(parts.find(interval=>interval.reviewSegment==='before')?.workspaceId,`manual::${tmpdir()}`);
  assert.equal(parts.find(interval=>interval.reviewSegment==='after')?.userAttribution,'unassigned');
  assert.equal(parts.find(interval=>interval.reviewSegment==='after')?.start,at+4);
  const action=collector.reviewHistory()[0]!;
  assert.equal(collector.reviewHistory().length,baseline+1);assert.equal(action.count,2);
  await collector.close();collector=new Collector(output);
  assert.equal(collector.store.humanSplits()[0]?.beforePath,tmpdir());
  collector.undoReviewAction(action.id,date);
  assert.deepEqual(collector.store.humanSplits(),original);
  assert.deepEqual(collector.store.humanDecisions(),[]);
  assert.deepEqual(collector.store.events(),observations);
  assert.ok(collector.dayReviewStatus('2026-11-11').backlog.some(item=>item.date===date&&item.pendingGroups===1));
 }finally{await collector.close();rmSync(output,{recursive:true,force:true});}
});

test('whole split assignment wins overlapping child selections and undo restores both paths and boundary',()=>{
 const store=new EventStore(':memory:');
 try{
  store.setHumanGroupSplit([pair],4,[[0,10]],'/original-before','/original-after');
  const original=store.humanSplits(),count=store.reviewActions().length;
  store.setHumanDecisions([pair,pair],'assigned','/replacement',[before,after,before]);
  assert.deepEqual(store.humanSplits(),[{...original[0]!,beforePath:'/replacement',afterPath:'/replacement'}]);
  assert.deepEqual(store.humanDecisions(),[]);
  assert.equal(store.reviewActions().length,count+1);assert.equal(store.reviewActions()[0]?.count,1);
  store.undoReviewAction(store.reviewActions()[0]!.id);
  assert.deepEqual(store.humanSplits(),original);
  store.setHumanDecisions([],'unassigned',null,[after]);
  assert.deepEqual(store.humanSplits(),[{...original[0]!,afterPath:null}]);
  store.undoReviewAction(store.reviewActions()[0]!.id);
  assert.deepEqual(store.humanSplits(),original);
  store.setHumanDecisions([pair],'clear',null);
  assert.deepEqual(store.humanSplits(),[]);assert.deepEqual(store.humanDecisions(),[]);
  store.undoReviewAction(store.reviewActions()[0]!.id);assert.deepEqual(store.humanSplits(),original);
 }finally{store.close();}
});

test('a stale segment rolls back other changes and records no partial history',()=>{
 const store=new EventStore(':memory:');
 try{
  const whole:[string,string]=['other-start','other-end'];
  store.setHumanDecisions([whole],'assigned','/original');
  const decisions=store.humanDecisions(),history=store.reviewActions();
  assert.throws(()=>store.setHumanDecisions([whole],'assigned','/new',[before]),/split changed/);
  assert.deepEqual(store.humanDecisions(),decisions);assert.deepEqual(store.reviewActions(),history);
  assert.throws(()=>store.setHumanDecisions([],'clear',null,[before]),/whole activity/);
 }finally{store.close();}
});

test('segment requests validate combined bounds and shape before calling the controller',async()=>{
 const calls:unknown[][]=[];
 const controller={status:()=>({}),summary:()=>({}),start:async()=>({}),stop:async()=>({}),setHumanDecision:(...args:unknown[])=>{calls.push(args);return true;}};
 const send=(params:unknown)=>dispatchRequest({id:'segments',method:'human_decision_set',params},controller);
 assert.deepEqual(await send({pairs:[],segments:[before,before],mode:'assigned',projectPath:'/project',date:'2026-11-10'}),{id:'segments',result:true});
 assert.deepEqual(calls[0],[[],'assigned','/project','2026-11-10',[before]]);
 await send({pairs:[pair,pair],segments:[before,after],mode:'unassigned'});
 assert.deepEqual(calls[1],[[pair],'unassigned',undefined,undefined,[]]);
 const accepted=calls.length;
 for(const segments of [null,{},[{}],[{pair:['a'],segment:'before'}],[{pair,segment:'middle'}],[{...before,extra:true}]])assert.ok('error' in await send({pairs:[pair],segments,mode:'unassigned'}));
 assert.ok('error' in await send({pairs:[],segments:[before],mode:'clear'}));
 assert.ok('error' in await send({pairs:[],segments:[],mode:'unassigned'}));
 assert.ok('error' in await send({pairs:[pair],segments:Array.from({length:10000},()=>before),mode:'unassigned'}));
 assert.equal(calls.length,accepted);
 assert.deepEqual(await send({pairs:[],segments:Array.from({length:10000},()=>before),mode:'unassigned'}),{id:'segments',result:true});
 assert.equal(calls.at(-1)?.[4] instanceof Array,true);
});
