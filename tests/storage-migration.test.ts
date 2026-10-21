import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync,renameSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventStore} from '../src/capture/store.ts';
import {DatabaseSync} from 'node:sqlite';
import {applyPendingReplacement,prepareCompaction,prepareRestore,pendingReplacement} from '../src/capture/storage-migration.ts';

function terminal(i:number){return {eventId:`terminal-${i}`,source:'orca' as const,kind:'terminal' as const,observedAt:100+i,monotonicAt:i,collectorEpoch:'epoch',hostId:'host',terminalHandle:'term',data:{title:'Same',connected:true}};}
test('verified compacted copy replaces storage on next launch and original remains restorable',()=>{
 const root=mkdtempSync(join(tmpdir(),'agent-time-replace-'));const source=join(root,'events.sqlite');
 let store=new EventStore(source);
 try{
  for(let i=0;i<1000;i++)store.put(terminal(i));
  store.setHumanDecisions([['a','b']],'assigned','/project');
  const before=store.count(),report=prepareCompaction(root,{idleThreshold:300,agentIdleThreshold:300},()=>store.revision());
  assert.ok(report.savingsBytes>0);assert.equal(store.count(),before);
  store.close();
  assert.equal(applyPendingReplacement(root),'applied');
  store=new EventStore(source);
  assert.equal(store.count(),2);
  assert.deepEqual(store.humanDecisions(),[{startEventId:'a',endEventId:'b',mode:'assigned',projectPath:'/project'}]);
  assert.equal(pendingReplacement(root),null);
  store.close();
  const backup=join(root,'exports',report.backup);assert.equal(existsSync(backup),true);
  prepareRestore(root,report.backup);
  assert.equal(applyPendingReplacement(root),'applied');
  store=new EventStore(source);
  assert.equal(store.count(),before);
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
test('replacement refuses data written after its compacted snapshot',()=>{
 const root=mkdtempSync(join(tmpdir(),'agent-time-stale-'));const source=join(root,'events.sqlite');
 const store=new EventStore(source);let closed=false;
 try{
  for(let i=0;i<1000;i++)store.put(terminal(i));
  prepareCompaction(root,{idleThreshold:300,agentIdleThreshold:300},()=>store.revision());
  store.put(terminal(1001));store.close();closed=true;
  assert.equal(applyPendingReplacement(root,()=>{}),'stale');
  const reopened=new EventStore(source);
  try{assert.equal(reopened.count(),1001);}finally{reopened.close();}
  assert.equal(pendingReplacement(root),null);
 }finally{if(!closed)store.close();rmSync(root,{recursive:true,force:true});}
});
test('interrupted replacement restores the original before opening storage',()=>{
 const root=mkdtempSync(join(tmpdir(),'agent-time-interrupted-'));const source=join(root,'events.sqlite');
 const store=new EventStore(source);
 try{
  for(let i=0;i<1000;i++)store.put(terminal(i));
  const report=prepareCompaction(root,{idleThreshold:300,agentIdleThreshold:300},()=>store.revision());
  store.close();
  renameSync(source,join(root,'exports',report.backup));
  assert.equal(applyPendingReplacement(root,()=>{}),'stale');
  const reopened=new EventStore(source);
  try{assert.equal(reopened.count(),1000);}finally{reopened.close();}
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('archive replacement rejects invalid captured event payloads',()=>{
 const root=mkdtempSync(join(tmpdir(),'agent-time-reject-'));const source=join(root,'events.sqlite');
 const store=new EventStore(source);
 try{
  store.put(terminal(0));store.close();mkdirSync(join(root,'exports'));
  const invalid=new EventStore(join(root,'exports','agent-time-2026-10-21T00-00-00-000Z-12345678-1234-1234-1234-123456789abc.sqlite'));
  invalid.put(terminal(1));invalid.close();
  const file=join(root,'exports','agent-time-2026-10-21T00-00-00-000Z-12345678-1234-1234-1234-123456789abc.sqlite');
  const db=new DatabaseSync(file);db.prepare('UPDATE events SET payload=?').run('{}');db.close();
  assert.throws(()=>prepareRestore(root,file.split('/').at(-1)!),/Invalid|match|event/i);
  assert.equal(pendingReplacement(root),null);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('replacement refuses a database still open in another app process',()=>{
 if(process.platform!=='darwin')return;
 const root=mkdtempSync(join(tmpdir(),'agent-time-open-'));const source=join(root,'events.sqlite');
 const store=new EventStore(source);
 try{
  for(let i=0;i<1000;i++)store.put(terminal(i));
  prepareCompaction(root,{idleThreshold:300,agentIdleThreshold:300},()=>store.revision());
  assert.throws(()=>applyPendingReplacement(root),/still has the tracking database open/);
  assert.equal(store.count(),1000);
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
