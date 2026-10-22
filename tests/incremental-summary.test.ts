import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Collector} from '../src/capture/collector.ts';
import {summarize} from '../src/capture/correlate.ts';
import {summaryForDate} from '../src/capture/daily.ts';
import {appendActivitySummary} from '../src/capture/incremental-summary.ts';
import {applyHumanDecisions} from '../src/capture/human-review.ts';
import type {CaptureEvent} from '../src/capture/events.ts';

const event=(id:string,at:number,kind='activity',source='macos',data:Record<string,unknown>={idleSeconds:0,foregroundBundleId:'com.example.Editor'}):CaptureEvent=>({eventId:id,source,kind,observedAt:at,monotonicAt:at,collectorEpoch:'one',data});

test('append-only Mac activity preserves exact full replay and daily totals',async()=>{
 const root=mkdtempSync(join(tmpdir(),'agent-time-incremental-'));
 const collector=new Collector(root);
 try{
  const old=[event('a',100),event('b',105),event('agent-start',106,'tool_start','hook',{toolId:'a'}),event('agent-end',110,'tool_end','hook',{toolId:'a'})];
  old[2]!.sessionId=old[3]!.sessionId='session';old[2]!.terminalHandle=old[3]!.terminalHandle='terminal';old[2]!.hostId=old[3]!.hostId='local';
  for(const item of old)collector.store.put(item);
  assert.deepEqual(collector.summary(),summarize(old));
  const fresh=[event('c',112),event('d',117)];
  for(const item of fresh)collector.store.put(item);
  assert.deepEqual(collector.summary(),summarize([...old,...fresh]));
  assert.deepEqual(collector.summaryForDate('1970-01-01'),summaryForDate(summarize([...old,...fresh]),'1970-01-01'));
  collector.store.setHumanDecisions([['a','b']],'assigned',root);
  const afterDecision=event('e',120);collector.store.put(afterDecision);
  assert.deepEqual(collector.summary(),applyHumanDecisions(summarize([...old,...fresh,afterDecision]),collector.store.humanDecisions()));
 }finally{await collector.close();rmSync(root,{recursive:true,force:true});}
});

test('activity projection declines agent events and a capture fence',()=>{
 const prior=event('a',100),following=event('b',110);
 const baseline=summarize([prior]);
 assert.equal(appendActivitySummary(baseline,prior,[event('start',105,'capture_start','capture'),following],300),null);
 assert.equal(appendActivitySummary(baseline,prior,[event('tool',105,'tool_start','hook'),following],300),null);
});

test('an appended foreground sample credits both sides of local midnight exactly once',async()=>{
 const root=mkdtempSync(join(tmpdir(),'agent-time-midnight-')),collector=new Collector(root);
 try{
  const midnight=new Date('2026-10-22T00:00:00').getTime()/1000;
  const before=event('before-midnight',midnight-4),after=event('after-midnight',midnight+4);
  collector.store.put(before);collector.summary();collector.store.put(after);
  for(const date of ['2026-10-21','2026-10-22'])assert.deepEqual(collector.summaryForDate(date),summaryForDate(summarize([before,after]),date));
 }finally{await collector.close();rmSync(root,{recursive:true,force:true});}
});
