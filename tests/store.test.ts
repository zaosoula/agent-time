import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../src/capture/store.ts';
import {retainedObservationRows} from '../src/capture/observation-retention.ts';
const event = { eventId: 'e1', source: 'test', kind: 'running', observedAt: 10, monotonicAt: 1, collectorEpoch: 'a' };
test('replays are idempotent and conflicting IDs are rejected', () => {
  const store = new EventStore(':memory:');
  assert.equal(store.put(event), true); assert.equal(store.put(event), false);
  assert.throws(() => store.put({ ...event, kind: 'stopped' }), /conflict/);
  assert.deepEqual(store.events(), [event]); store.close();
});
test('nonfinite timestamps are rejected and clock rollback is retained', () => {
  const store = new EventStore(':memory:');
  assert.throws(() => store.put({ ...event, observedAt: NaN }));
  store.put(event); store.put({ ...event, eventId: 'e2', observedAt: 5, monotonicAt: 2 });
  assert.equal(store.events()[1].observedAt, 5); store.close();
});
test('database files and directory are private', () => {
  const root = mkdtempSync(join(tmpdir(), 'ade-store-')); const path = join(root, 'private/events.sqlite');
  const store = new EventStore(path); store.put(event); store.close();
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(root, 'private')).mode & 0o777, 0o700); rmSync(root, { recursive: true });
});
test('lightweight count and revision reflect local inserts, duplicate replay and external database changes',async()=>{
 const {DatabaseSync}=await import('node:sqlite');const root=mkdtempSync(join(tmpdir(),'ade-store-revision-')),path=join(root,'events.sqlite');const store=new EventStore(path);
 try{
  const empty=store.revision();assert.equal(store.count(),0);store.put(event);assert.equal(store.count(),1);assert.notEqual(store.revision(),empty);const current=store.revision();store.put(event);assert.equal(store.revision(),current);
  const external=new DatabaseSync(path);external.prepare('INSERT INTO events VALUES(?,?,?)').run('external',20,JSON.stringify({...event,eventId:'external',observedAt:20}));external.close();assert.equal(store.count(),2);assert.notEqual(store.revision(),current);
 }finally{store.close();rmSync(root,{recursive:true});}
});
test('recent capture-health reads use the source index and retain row order',async()=>{
 const {DatabaseSync}=await import('node:sqlite');const root=mkdtempSync(join(tmpdir(),'ade-recent-')),path=join(root,'events.sqlite');const store=new EventStore(path);
 try{
  for(let n=0;n<30;n++)store.put({...event,eventId:`noise-${n}`,source:'orca',observedAt:n});
  store.put({...event,eventId:'capture-1',source:'capture',observedAt:31});
  store.put({...event,eventId:'hook-claude',source:'hook',provider:'claude',observedAt:32});
  store.put({...event,eventId:'capture-2',source:'capture',observedAt:33});
  assert.deepEqual(store.recent('capture',2).map(item=>item.eventId),['capture-2','capture-1']);
  assert.deepEqual(store.recent('hook',2,'claude').map(item=>item.eventId),['hook-claude']);
  const db=new DatabaseSync(path,{readOnly:true});
  const plan=String(db.prepare("EXPLAIN QUERY PLAN SELECT payload FROM events WHERE json_extract(payload,'$.source')=? ORDER BY rowid DESC LIMIT ?").all('capture',2)[0]?.detail);
  assert.match(plan,/events_source_recent/);db.close();
 }finally{store.close();rmSync(root,{recursive:true});}
});
test('settled worker and unchanged terminal snapshots are stored once across restarts',()=>{
 const root=mkdtempSync(join(tmpdir(),'ade-observations-')),path=join(root,'events.sqlite');
 const worker=(id:string,time:number,outcome='succeeded')=>({...event,eventId:id,source:'orca',kind:'worker',observedAt:time,hostId:'host',dispatchId:'dispatch',terminalHandle:'term',data:{outcome,state:'unknown',fresh:false}});
 const terminal=(id:string,time:number,title='First')=>({...event,eventId:id,source:'orca',kind:'terminal',observedAt:time,hostId:'host',terminalHandle:'term',data:{title,connected:true}});
 let store=new EventStore(path);
 try{
  assert.equal(store.putObservations([worker('w1',1),worker('w2',2),terminal('t1',1),terminal('t2',2)]),2);
  store.close();store=new EventStore(path);
  assert.equal(store.putObservations([worker('w3',3),terminal('t3',3),worker('w4',4,'failed'),terminal('t4',4,'Renamed')]),2);
  assert.deepEqual(store.events().map(e=>e.eventId),['w1','t1','w4','t4']);
 }finally{store.close();rmSync(root,{recursive:true});}
});
test('fresh worker observations retain timing and failed batches leave no partial state',()=>{
 const store=new EventStore(':memory:');
 const worker=(id:string,time:number)=>({...event,eventId:id,source:'orca',kind:'worker',observedAt:time,hostId:'host',dispatchId:'dispatch',data:{outcome:'in_progress',state:'working',fresh:true}});
 try{
  const revision=store.revision();
  assert.throws(()=>store.putObservations([worker('w1',1),worker('bad',NaN)]));
  assert.equal(store.count(),0);assert.equal(store.revision(),revision);
  assert.equal(store.putObservations([worker('w1',1),worker('w2',2)]),2);
  assert.deepEqual(store.events().map(e=>e.eventId),['w1','w2']);
 }finally{store.close();}
});
test('historical retention keeps first and last state observations plus every active sample',()=>{
 const worker=(id:string,time:number,outcome='succeeded',fresh=false)=>({...event,eventId:id,source:'orca',kind:'worker',observedAt:time,hostId:'host',dispatchId:'dispatch',data:{outcome,state:fresh?'working':'unknown',fresh}});
 const events=[worker('first',1),worker('middle',2),worker('last',3),worker('changed',4,'failed'),worker('changed-last',5,'failed'),worker('active',6,'in_progress',true),worker('active-2',7,'in_progress',true)];
 const retained=retainedObservationRows(events.map((entry,index)=>({rowid:index+1,event:entry})));
 assert.deepEqual([...retained].sort((a,b)=>a-b),[1,3,4,5,6,7]);
});
