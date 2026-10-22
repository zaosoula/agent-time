import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync,mkdirSync,copyFileSync,symlinkSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventStore} from '../src/capture/store.ts';
import {makeEvent} from '../src/capture/events.ts';
import {DatabaseSync} from 'node:sqlite';

test('archive is an independently readable verified snapshot with decisions and notes',async()=>{
 const output=mkdtempSync(join(tmpdir(),'agent-time-archive-'));
 let store=new EventStore(join(output,'events.sqlite'));
 try{
  store.put(makeEvent('capture','capture_start'));
  const start=new Date(2026,9,19,11).getTime()/1000;
  store.addManualNote({start,end:start+60,project:'Project A',note:'User entered'});
  const archive=await store.exportArchive(output);
  assert.equal(archive.events,1);assert.ok(statSync(archive.path).size>0);
  store.put(makeEvent('capture','capture_stop'));
  store.close();
  store=new EventStore(archive.path);
  assert.equal(store.count(),1);
  assert.equal(store.manualNotes('2026-10-19')[0]?.note,'User entered');
  assert.equal(store.quickCheck(),true);
 }finally{store.close();rmSync(output,{recursive:true});}
});
test('archive cleanup only deletes an explicitly selected app-owned copy',async()=>{
 const root=mkdtempSync(join(tmpdir(),'agent-time-archive-delete-'));
 const store=new EventStore(join(root,'events.sqlite'));
 try{
  store.put(makeEvent('capture','capture_start'));
  const archive=await store.exportArchive(root),id=archive.path.split('/').at(-1)!;
  assert.throws(()=>store.deleteArchive(root,'../events.sqlite'),/Invalid archive/);
  assert.equal(store.deleteArchive(root,id),true);
  assert.equal(existsSync(archive.path),false);
  assert.equal(store.count(),1);
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('an owned archive previews and restores missing evidence without overwriting live events',async()=>{
 const first=mkdtempSync(join(tmpdir(),'agent-time-archive-source-'));
 const second=mkdtempSync(join(tmpdir(),'agent-time-archive-target-'));
 const source=new EventStore(join(first,'events.sqlite'));
 const target=new EventStore(join(second,'events.sqlite'));
 try{
  const event=makeEvent('capture','capture_start');
  source.put(event);
  const start=new Date(2026,9,19,11).getTime()/1000;
  source.addManualNote({start,end:start+60,project:'Project A',note:'From archive'});
  source.setHumanGroupSplit([['start','end']],start+30,[[start,start+60]],'/project-a','/project-b');
  source.markDayReview('2026-10-19','review-fingerprint');
  const saved=await source.exportArchive(first);
  mkdirSync(join(second,'exports'));
  copyFileSync(saved.path,join(second,'exports',saved.path.split('/').at(-1)!));
  const archiveId=saved.path.split('/').at(-1)!;
  const preview=target.previewArchive(second,archiveId);
  assert.equal(preview.newEvents,1);
  assert.equal(preview.newNotes,1);
  assert.equal(preview.newSplits,1);
  assert.equal(preview.newReviewActions,1);
  assert.equal(preview.newDayReviews,1);
  assert.equal(target.count(),0);
  const imported=target.importArchive(second,archiveId);
  assert.equal(imported.addedEvents,1);
  assert.equal(imported.addedNotes,1);
  assert.equal(target.count(),1);
  assert.equal(target.manualNotes('2026-10-19')[0]?.note,'From archive');
  assert.equal(target.humanSplits()[0]?.splitAt,start+30);
  assert.equal(target.reviewActions()[0]?.mode,'split');
  assert.equal(target.dayReview('2026-10-19')?.fingerprint,'review-fingerprint');
  assert.equal(target.importArchive(second,archiveId).addedEvents,0);
  symlinkSync(saved.path,join(second,'exports','agent-time-unsafe.sqlite'));
  assert.throws(()=>target.previewArchive(second,'../events.sqlite'));
  assert.throws(()=>target.previewArchive(second,'agent-time-unsafe.sqlite'));
 }finally{source.close();target.close();rmSync(first,{recursive:true});rmSync(second,{recursive:true});}
});

test('restore rejects a structurally valid archive with an invalid event payload',async()=>{
 const root=mkdtempSync(join(tmpdir(),'agent-time-invalid-archive-'));
 const store=new EventStore(join(root,'events.sqlite'));
 try{
  store.put(makeEvent('capture','capture_start'));
  const archive=await store.exportArchive(root);
  const copy=new DatabaseSync(archive.path);
  copy.prepare('UPDATE events SET payload=?').run(JSON.stringify({eventId:'tampered',source:'capture',observedAt:'bad'}));
  copy.close();
  store.close();
  const fresh=new EventStore(join(root,'fresh.sqlite'));
  try{
   assert.throws(()=>fresh.importArchive(root,archive.path.split('/').at(-1)!),/Invalid|match|event/i);
   assert.equal(fresh.count(),0);
  }finally{fresh.close();}
 }finally{rmSync(root,{recursive:true});}
});
test('archive preview refuses conflicting usage records before writing',async()=>{
 const root=mkdtempSync(join(tmpdir(),'agent-time-usage-conflict-'));
 const store=new EventStore(join(root,'events.sqlite'));
 try{
  const archive=await store.exportArchive(root),id=archive.path.split('/').at(-1)!;
  for(const [path,tokens] of [[archive.path,10],[join(root,'events.sqlite'),20]] as const){
   const db=new DatabaseSync(path);
   try{db.exec('CREATE TABLE usage_events (id TEXT PRIMARY KEY, timestamp REAL NOT NULL, payload TEXT NOT NULL)');db.prepare('INSERT INTO usage_events VALUES (?,?,?)').run('usage-1',100,JSON.stringify({id:'usage-1',timestamp:100,provider:'claude',input:tokens}));}
   finally{db.close();}
  }
  assert.equal(store.previewArchive(root,id).usageConflicts,1);
  assert.throws(()=>store.importArchive(root,id),/conflicts/i);
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
