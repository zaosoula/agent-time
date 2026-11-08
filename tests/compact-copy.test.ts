import {openEventDatabase} from '../src/capture/event-database.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {EventStore} from '../src/capture/store.ts';
import {DatabaseSync} from 'node:sqlite';
import {staticOrcaScopeReason} from '../src/capture/observation-retention.ts';
import {compactCaptureCopy} from '../src/capture/compact-copy.ts';
import {summarize} from '../src/capture/correlate.ts';
import type {CaptureEvent} from '../src/capture/events.ts';

test('offline compacted copy preserves causal event order and review decisions',()=>{
 const root=mkdtempSync(join(tmpdir(),'agent-time-compact-')),source=join(root,'source.sqlite'),target=join(root,'target.sqlite');
 const store=new EventStore(source);
 try{
  for(let i=0;i<4;i++)store.put({eventId:`terminal-${i}`,source:'orca',kind:'terminal',observedAt:100+i,monotonicAt:i,collectorEpoch:'epoch',hostId:'host',terminalHandle:'term',data:{title:'Same',connected:true}});
  for(let i=0;i<4;i++)store.put({eventId:`scope-${i}`,source:'orca',kind:'coverage',observedAt:200+i,monotonicAt:i,collectorEpoch:'epoch',data:{reason:staticOrcaScopeReason}});
  store.setHumanDecisions([['a','b']],'assigned','/project');
  store.setHumanGroupSplit([['c','d']],102,[[100,104]],'/before','/after');
  store.markDayReview('2026-10-22','fingerprint');
  store.close();
  const result=spawnSync(process.execPath,[resolve('scripts/compact-capture-copy.mjs'),source,target],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const report=JSON.parse(result.stdout);
  assert.equal(report.beforeRows,8);
  assert.equal(report.afterRows,4);
  const compacted=new EventStore(target);
  try{assert.deepEqual(compacted.events().map(event=>event.eventId),['terminal-0','terminal-3','scope-0','scope-3']);assert.deepEqual(compacted.humanDecisions(),[{startEventId:'a',endEventId:'b',mode:'assigned',projectPath:'/project'}]);assert.equal(compacted.humanSplits()[0]?.splitAt,102);assert.equal(compacted.reviewActions().length,2);assert.equal(compacted.dayReview('2026-10-22')?.fingerprint,'fingerprint');}
  finally{compacted.close();}
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('compaction streams payloads larger than its JavaScript heap budget',()=>{
 const root=mkdtempSync(join(tmpdir(),'agent-time-compact-memory-')),source=join(root,'source.sqlite'),target=join(root,'target.sqlite');
 try{
  const store=new EventStore(source);store.close();
  const db=openEventDatabase(source),put=db.prepare('INSERT INTO events(event_id,observed_at,payload_data) VALUES(?,?,?)');
  db.exec('BEGIN');
  for(let i=0;i<30_000;i++){
   const event={eventId:`empty-${i}`,source:'orca',kind:'worker',observedAt:100+i,monotonicAt:i,collectorEpoch:'epoch',dispatchId:'empty-dispatch',data:{state:'unknown',padding:'x'.repeat(4096)}};
   put.run(event.eventId,event.observedAt,JSON.stringify(event));
  }
  db.exec('COMMIT');db.close();
  const result=spawnSync(process.execPath,['--max-old-space-size=64',resolve('scripts/compact-capture-copy.mjs'),source,target],{encoding:'utf8',timeout:60_000});
  assert.equal(result.status,0,result.stderr);
  const report=JSON.parse(result.stdout);
  assert.equal(report.beforeRows,30_000);
  assert.equal(report.afterRows,0);
  const original=new EventStore(source);
  try{assert.equal(original.count(),30_000);}finally{original.close();}
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('empty-looking workers stay when a hook or another worker can use their dispatch',()=>{
 for(const blocker of [
  {source:'hook',kind:'tool_start',dispatchId:'dispatch',terminalHandle:'term',sessionId:'session'},
  {source:'other',kind:'worker',dispatchId:'dispatch',data:{fresh:true,state:'working'}},
  {source:'orca',kind:'worker',dispatchId:'dispatch',sessionId:'session'},
 ]){
  const root=mkdtempSync(join(tmpdir(),'agent-time-compact-binding-')),source=join(root,'source.sqlite'),target=join(root,'target.sqlite');
  const store=new EventStore(source);
  try{
   const base={source:'orca',kind:'worker',collectorEpoch:'epoch',dispatchId:'dispatch'};
   const events=[{...base,eventId:'first',observedAt:100,monotonicAt:1},{...base,...blocker,eventId:'bound',observedAt:110,monotonicAt:2},{...base,eventId:'last',observedAt:120,monotonicAt:3}] as CaptureEvent[];
   for(const event of events)store.put(event);
   const before=summarize(events);assert.equal(before.sessions[0]!.lastObservedAt,120);
   store.close();
   assert.equal(compactCaptureCopy(source,target).afterRows,3);
   const compacted=new EventStore(target);
   try{assert.deepEqual(summarize(compacted.events()),before);}finally{compacted.close();}
  }finally{if(store.database.isOpen)store.close();rmSync(root,{recursive:true,force:true});}
 }
});

test('compaction preserves global tool timing across multiple days and collector epochs',()=>{
 const root=mkdtempSync(join(tmpdir(),'agent-time-compact-days-')),source=join(root,'source.sqlite'),target=join(root,'target.sqlite');
 const store=new EventStore(source);
 try{
  const hook={source:'hook',collectorEpoch:'hook',terminalHandle:'term',hostId:'host',sessionId:'session',data:{toolId:'tool'}};
  const events:CaptureEvent[]=[{...hook,eventId:'start',kind:'tool_start',observedAt:100,monotonicAt:1},
   ...[200,90_000,180_000].map((at,i)=>({eventId:`terminal-${i}`,source:'orca',kind:'terminal',observedAt:at,monotonicAt:i,collectorEpoch:'poll',hostId:'host',terminalHandle:'term',data:{title:'Same'}})),
   {...hook,eventId:'end',kind:'tool_end',observedAt:260_000,monotonicAt:2}];
  for(const event of events)store.put(event);
  const before=summarize(events);assert.equal(before.agentSeconds,300);assert.equal(before.sessions[0]!.observedSeconds,300);
  store.close();
  assert.equal(compactCaptureCopy(source,target).afterRows,4);
  const compacted=new EventStore(target);
  try{assert.deepEqual(summarize(compacted.events()),before);}finally{compacted.close();}
 }finally{if(store.database.isOpen)store.close();rmSync(root,{recursive:true,force:true});}
});

test('clock-envelope rows are retained to preserve meaningful evidence order',()=>{
 const root=mkdtempSync(join(tmpdir(),'agent-time-compact-clock-')),source=join(root,'source.sqlite'),target=join(root,'target.sqlite');
 const store=new EventStore(source);
 try{
  const hook={source:'hook',collectorEpoch:'a',terminalHandle:'term',hostId:'host',sessionId:'session',data:{toolId:'tool'}};
  const events:CaptureEvent[]=[{...hook,eventId:'start',kind:'tool_start',observedAt:50,monotonicAt:1},
   ...[90,200,90].map((at,i)=>({eventId:`terminal-${i}`,source:'orca',kind:'terminal',observedAt:at,monotonicAt:i+2,collectorEpoch:'a',hostId:'host',terminalHandle:'term',data:{title:'Same'}})),
   {...hook,eventId:'end',kind:'tool_end',observedAt:100,monotonicAt:5},
   {eventId:'stop',source:'capture',kind:'capture_stop',observedAt:150,monotonicAt:1,collectorEpoch:'b'}];
  for(const event of events)store.put(event);store.close();
  assert.equal(compactCaptureCopy(source,target).afterRows,6);
  const compacted=new EventStore(target);
  try{assert.deepEqual(summarize(compacted.events()),summarize(events));}finally{compacted.close();}
  const original=new EventStore(source);
  try{assert.equal(original.count(),6);}finally{original.close();}
 }finally{if(store.database.isOpen)store.close();rmSync(root,{recursive:true,force:true});}
});

test('compaction rejects a payload ID that disagrees with the SQLite primary key',()=>{
 const root=mkdtempSync(join(tmpdir(),'agent-time-compact-invalid-')),source=join(root,'source.sqlite'),target=join(root,'target.sqlite');
 const store=new EventStore(source);
 try{
  store.put({eventId:'original',source:'capture',kind:'capture_start',observedAt:1,monotonicAt:1,collectorEpoch:'epoch'});store.close();
  const db=openEventDatabase(source);db.exec("UPDATE events SET event_id='different'");db.close();
  assert.throws(()=>compactCaptureCopy(source,target),/columns do not match/);
  assert.equal(existsSync(target),false);
 }finally{if(store.database.isOpen)store.close();rmSync(root,{recursive:true,force:true});}
});
