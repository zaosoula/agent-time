import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventStore} from '../src/capture/store.ts';
import {makeEvent} from '../src/capture/events.ts';

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
