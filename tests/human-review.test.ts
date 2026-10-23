import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Collector} from '../src/capture/collector.ts';
import {makeEvent} from '../src/capture/events.ts';
import {groupHumanReview} from '../src/capture/human-review.ts';
import {summaryForDate} from '../src/capture/daily.ts';
import {reviewedCsv,weeklyReview} from '../src/capture/weekly.ts';

test('a human interval can be assigned, left unassigned, undone, and restored after restart without changing observations',async()=>{
 const output=mkdtempSync(join(tmpdir(),'agent-time-human-review-'));
 let collector=new Collector(output);
 try{
  const now=Date.now()/1000;
  const first=makeEvent('macos','activity',{observedAt:now,monotonicAt:1,workspaceId:'observed::/original',data:{idleSeconds:0,foregroundBundleId:'com.brave.Browser',foregroundName:'Brave',browserDomain:'example.com',browserUrl:'https://example.com/page',browserTitle:'Page'}});
  const second=makeEvent('macos','activity',{observedAt:now+2,monotonicAt:3,workspaceId:'observed::/original',data:{idleSeconds:0,foregroundBundleId:'com.brave.Browser',foregroundName:'Brave',browserDomain:'example.com',browserUrl:'https://example.com/page',browserTitle:'Page'}});
  collector.store.put(first);collector.store.put(second);
  const pair:[string,string]=[first.eventId,second.eventId];
  const before=collector.store.events();
  const originalSummary=collector.summary();
  let interval=originalSummary.intervals.find(i=>i.state==='human');
  assert.equal(interval?.workspaceId,'observed::/original');
  const assigned=collector.setHumanDecision([pair],'assigned',output);
  assert.equal(assigned.intervals.find(i=>i.state==='human')?.workspaceId,`manual::${output}`);
  const day=new Date(now*1000),date=`${day.getFullYear()}-${String(day.getMonth()+1).padStart(2,'0')}-${String(day.getDate()).padStart(2,'0')}`;
  assert.equal(summaryForDate(assigned,date).humanSeconds,summaryForDate(originalSummary,date).humanSeconds);
  const monday=new Date(day);monday.setHours(0,0,0,0);monday.setDate(monday.getDate()-(monday.getDay()+6)%7);
  const weekStart=`${monday.getFullYear()}-${String(monday.getMonth()+1).padStart(2,'0')}-${String(monday.getDate()).padStart(2,'0')}`;
  const week=weeklyReview(assigned,weekStart);
  assert.ok(week.projects.some(project=>project.project===output&&project.humanSeconds>0));
  assert.match(reviewedCsv(week.reviewedEntries),/Brave/);
  assert.deepEqual(collector.store.events(),before);
  await collector.close();collector=new Collector(output);
  interval=collector.summary().intervals.find(i=>i.state==='human');
  assert.equal(interval?.userAttribution,'assigned');
  assert.equal(interval?.workspaceId,`manual::${output}`);
  const history=collector.reviewHistory();
  assert.equal(history.length,1);
  assert.equal(history[0]?.mode,'assigned');
  assert.deepEqual(history[0]?.eventIds,[first.eventId,second.eventId]);
  interval=collector.undoReviewAction(history[0]!.id).intervals.find(i=>i.state==='human');
  assert.equal(interval?.workspaceId,'observed::/original');
  assert.equal(collector.reviewHistory()[0]?.undoneAt!==null,true);
  collector.setHumanDecision([pair],'assigned',output);
  interval=collector.setHumanDecision([pair],'unassigned').intervals.find(i=>i.state==='human');
  assert.equal(interval?.workspaceId,undefined);
  assert.equal(interval?.userAttribution,'unassigned');
  interval=collector.setHumanDecision([pair],'clear').intervals.find(i=>i.state==='human');
  assert.equal(interval?.workspaceId,'observed::/original');
  assert.equal(interval?.userAttribution,undefined);
  const split=collector.setHumanGroupSplit([pair],now+1,output);
  const parts=split.intervals.filter(i=>i.state==='human');
  assert.equal(parts.length,2);
  assert.equal(parts[0]?.end,now+1);
  assert.equal(parts[0]?.workspaceId,`manual::${output}`);
  assert.equal(parts[1]?.start,now+1);
  assert.equal(parts[1]?.userAttribution,'unassigned');
  assert.equal(summaryForDate(split,date).humanSeconds,summaryForDate(originalSummary,date).humanSeconds);
  await collector.close();collector=new Collector(output);
  assert.equal(collector.summary().intervals.filter(i=>i.state==='human').length,2);
  const latest=collector.reviewHistory()[0]!;
  assert.equal(latest.mode,'split');
  assert.equal(collector.undoReviewAction(latest.id).intervals.filter(i=>i.state==='human').length,1);
  assert.deepEqual(collector.store.events(),before);
  assert.throws(()=>collector.setHumanDecision([['wrong',second.eventId]],'assigned',output),/Activity changed/);
 }finally{await collector.close();rmSync(output,{recursive:true,force:true});}
});

test('review groups nearby observations of one page but keeps separate pages separate',()=>{
 const base={state:'human' as const,proof:'inferred' as const,browserDomain:'example.com',foregroundName:'Brave'};
 const groups=groupHumanReview([
  {...base,start:100,end:102,browserUrl:'https://example.com/a',sourceEventIds:['a','b']},
  {...base,start:105,end:107,browserUrl:'https://example.com/a',sourceEventIds:['b','c']},
  {...base,start:108,end:110,browserUrl:'https://example.com/b',sourceEventIds:['c','d']},
 ]);
 assert.equal(groups.length,2);
 assert.deepEqual(groups[1]?.pairs,[['a','b'],['b','c']]);
 assert.deepEqual(groups[0]?.pairs,[['c','d']]);
});

test('day review survives restart and reopens only when that day changes',async()=>{
 const output=mkdtempSync(join(tmpdir(),'agent-time-day-review-'));
 let collector=new Collector(output);
 try{
  const at=new Date(2026,9,22,10).getTime()/1000,date='2026-10-22';
  collector.store.put(makeEvent('macos','activity',{observedAt:at,monotonicAt:1,data:{idleSeconds:0,foregroundBundleId:'com.example.Editor'}}));
  collector.store.put(makeEvent('macos','activity',{observedAt:at+10,monotonicAt:11,data:{idleSeconds:0,foregroundBundleId:'com.example.Editor'}}));
  assert.equal(collector.dayReviewStatus(date).completedAt,null);
  assert.equal(collector.markDayReview(date).stale,false);
  await collector.close();collector=new Collector(output);
  assert.equal(collector.dayReviewStatus(date).stale,false);
  collector.store.put(makeEvent('capture','coverage',{observedAt:at+86400,monotonicAt:12,data:{reason:'A later day has a gap'}}));
  assert.equal(collector.dayReviewStatus(date).stale,false);
  collector.store.put(makeEvent('capture','coverage',{observedAt:at+20,monotonicAt:13,data:{reason:'This day has a gap'}}));
  assert.equal(collector.dayReviewStatus(date).stale,true);
 }finally{await collector.close();rmSync(output,{recursive:true,force:true});}
});
