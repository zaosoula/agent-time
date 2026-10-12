import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventStore } from '../src/capture/store.ts';
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
