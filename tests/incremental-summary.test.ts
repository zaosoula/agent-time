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

test('day summaries replay agent and Orca changes from a bounded window, never the whole history',async()=>{
 const root=mkdtempSync(join(tmpdir(),'agent-time-replay-cache-')),collector=new Collector(root);
 try{
  const old=[event('a',100),event('b',105)];for(const item of old)collector.store.put(item);
  const date='1970-01-01';
  collector.store.events=()=>{throw new Error('Unexpected full database read');};
  assert.deepEqual(collector.summaryForDate(date),summaryForDate(summarize(old),date));
  const days=(collector as any).days;const computed=days.computations;
  // Activity samples append in place.
  const sample=event('c',108);collector.store.put(sample);
  assert.deepEqual(collector.summaryForDate(date),summaryForDate(summarize([...old,sample]),date));
  assert.equal(days.computations,computed);
  const hook=event('hook',110,'tool_start','hook',{toolId:'one'});hook.sessionId='session';hook.terminalHandle='terminal';hook.hostId='local';
  collector.store.put(hook);
  assert.deepEqual(collector.summaryForDate(date),summaryForDate(summarize([...old,sample,hook]),date));
  const worker=event('worker',115,'worker','orca',{state:'working'});worker.hostId='local';worker.dispatchId='dispatch';worker.terminalHandle='terminal';
  collector.store.put(worker);
  assert.deepEqual(collector.summaryForDate(date),summaryForDate(summarize([...old,sample,hook,worker]),date));
  // A closed day elsewhere is untouched by the new rows.
  assert.equal(days.computations,computed+2);
 }finally{await collector.close();rmSync(root,{recursive:true,force:true});}
});

test('a day summary reads about one day of samples however long the history is',async()=>{
 const root=mkdtempSync(join(tmpdir(),'agent-time-bounded-')),collector=new Collector(root);
 try{
  const day=new Date('2026-10-22T00:00:00').getTime()/1000;
  // Sixty days of five-second samples precede the day of interest.
  collector.store.transaction(()=>{for(let at=day-60*86400;at<day+86400;at+=5)collector.store.put(event(`s${at}`,at));});
  let read=0;const windowEvents=collector.store.windowEvents.bind(collector.store);
  collector.store.windowEvents=(from:number,to:number,idle:number)=>{const result=windowEvents(from,to,idle);read+=result.events.length;return result;};
  const summary=collector.summaryForDate('2026-10-22');
  assert.equal(summary.humanSeconds,86400);
  // One day of samples plus the activity margins, not the 60 days before it.
  assert.ok(read<86400/5+100,`read ${read} events`);
 }finally{await collector.close();rmSync(root,{recursive:true,force:true});}
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
