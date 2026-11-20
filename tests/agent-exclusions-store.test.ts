import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {EventStore} from '../src/capture/store.ts';
import {makeEvent} from '../src/capture/events.ts';
import {ingestionJournalState,readIngestionChanges} from '../src/capture/ingestion-journal.ts';
import {createPackedEventSchema,openEventDatabase} from '../src/capture/event-database.ts';

const day=new Date(2026,10,17,9).getTime()/1000;
const input=(offset:number,length=600)=>({executionKey:'host::claude::s1',date:'2026-11-17',start:day+offset,end:day+offset+length,provider:'claude',sessionId:'s1'});

test('exclusions persist across reopen and undo keeps other exclusions',()=>{
 const root=mkdtempSync(join(tmpdir(),'at-exclusions-'));const path=join(root,'events.sqlite');let store=new EventStore(path);
 try{
  const second=store.addAgentTimeExclusion(input(3600)),first=store.addAgentTimeExclusion(input(0));
  assert.equal(first.executionKey,'host::claude::s1');assert.equal(first.undoneAt,undefined);assert.ok(first.createdAt>0);
  store.close();store=new EventStore(path);
  assert.deepEqual(store.agentTimeExclusions('2026-11-17').map(x=>x.id),[first.id,second.id]);
  assert.deepEqual(store.agentTimeExclusions().map(x=>x.id),[first.id,second.id]);
  assert.deepEqual(store.agentTimeExclusions('2026-11-18'),[]);
  const undone=store.undoAgentTimeExclusion(first.id,'2026-11-17');assert.ok(undone.undoneAt);
  assert.deepEqual(store.agentTimeExclusions('2026-11-17'),[second]);
  assert.ok(store.database.prepare('SELECT undone_at FROM agent_time_exclusions WHERE id=?').get(first.id)?.undone_at);
  assert.throws(()=>store.undoAgentTimeExclusion(first.id,'2026-11-17'),/Correction not found/);
  assert.throws(()=>store.undoAgentTimeExclusion('missing','2026-11-17'),/Correction not found/);
  assert.throws(()=>store.undoAgentTimeExclusion(second.id,'2026-11-18'),/Correction not found/);
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('adding or undoing bumps the review revision',()=>{
 const store=new EventStore(':memory:');try{
  const initial=store.dependencyRevision('review');const added=store.addAgentTimeExclusion(input(0));
  const afterAdd=store.dependencyRevision('review');assert.notEqual(afterAdd,initial);
  store.undoAgentTimeExclusion(added.id,'2026-11-17');assert.notEqual(store.dependencyRevision('review'),afterAdd);
 }finally{store.close();}
});

test('range changes are journaled',()=>{
 const store=new EventStore(':memory:');try{
  const before=ingestionJournalState(store.database).sequence,x=input(0);store.addAgentTimeExclusion(x);
  const changes=readIngestionChanges(store.database,before,10);
  assert.deepEqual(changes.map(c=>({kind:c.kind,pairs:c.pairs})),[{kind:'range',pairs:[[x.start,x.end]]}]);
 }finally{store.close();}
});

test('packed databases create the table and its triggers',()=>{
 const root=mkdtempSync(join(tmpdir(),'at-exclusions-packed-'));const path=join(root,'events.sqlite');
 const db=openEventDatabase(path);createPackedEventSchema(db);db.close();const store=new EventStore(path);
 try{
  const revision=store.dependencyRevision('review'),before=ingestionJournalState(store.database).sequence;store.addAgentTimeExclusion(input(0));
  assert.notEqual(store.dependencyRevision('review'),revision);assert.equal(readIngestionChanges(store.database,before,10)[0]?.kind,'range');
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

async function archived(dropTable:boolean){
 const first=mkdtempSync(join(tmpdir(),'at-exclusions-archive-source-')),second=mkdtempSync(join(tmpdir(),'at-exclusions-archive-target-'));
 const source=new EventStore(join(first,'events.sqlite')),target=new EventStore(join(second,'events.sqlite'));
 try{
  source.put(makeEvent('capture','capture_start'));const kept=source.addAgentTimeExclusion(input(0)),undone=source.addAgentTimeExclusion(input(3600));source.undoAgentTimeExclusion(undone.id,'2026-11-17');
  const saved=await source.exportArchive(first),id=saved.path.split('/').at(-1)!;
  mkdirSync(join(second,'exports'));copyFileSync(saved.path,join(second,'exports',id));
  if(dropTable){const db=new DatabaseSync(join(second,'exports',id));db.exec('DROP TABLE agent_time_exclusions');db.close();}
  const preview=target.previewArchive(second,id);
  target.importArchive(second,id);
  return {preview,kept,undone,active:target.agentTimeExclusions(),rows:Number(target.database.prepare('SELECT count(*) n FROM agent_time_exclusions').get()!.n)};
 }finally{source.close();target.close();rmSync(first,{recursive:true,force:true});rmSync(second,{recursive:true,force:true});}
}
test('archive merge copies exclusions',async()=>{
 const result=await archived(false);assert.deepEqual(result.active,[result.kept]);assert.equal(result.rows,2);assert.equal(result.preview.newCorrections,2);assert.equal(result.preview.correctionConflicts,0);
});
test('archive merge tolerates archives without exclusions',async()=>{
 const result=await archived(true);assert.deepEqual(result.active,[]);assert.equal(result.rows,0);assert.equal(result.preview.newCorrections,0);
});
