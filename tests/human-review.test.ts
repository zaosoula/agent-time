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
  interval=collector.setHumanDecision([pair],'unassigned').intervals.find(i=>i.state==='human');
  assert.equal(interval?.workspaceId,undefined);
  assert.equal(interval?.userAttribution,'unassigned');
  interval=collector.setHumanDecision([pair],'clear').intervals.find(i=>i.state==='human');
  assert.equal(interval?.workspaceId,'observed::/original');
  assert.equal(interval?.userAttribution,undefined);
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
