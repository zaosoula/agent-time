import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventStore} from '../src/capture/store.ts';
import {storageUsage} from '../src/capture/storage-usage.ts';

test('storage report separates database, spool, runtimes and exports without following links',()=>{
 const root=mkdtempSync(join(tmpdir(),'agent-time-storage-'));
 const store=new EventStore(join(root,'events.sqlite'));
 try{
  const now=Date.now()/1000;
  store.put({eventId:'mac',source:'macos',kind:'activity',observedAt:now,monotonicAt:1,collectorEpoch:'a'});
  mkdirSync(join(root,'spool'));writeFileSync(join(root,'spool','one.json'),'x'.repeat(17));
  mkdirSync(join(root,'hook-runtime'));writeFileSync(join(root,'hook-runtime','node'),'x'.repeat(23));
  mkdirSync(join(root,'exports'));writeFileSync(join(root,'exports','saved.sqlite'),'x'.repeat(29));
  symlinkSync(join(root,'exports'),join(root,'spool','linked-export'));
  const report=storageUsage(root);
  assert.equal(report.eventCount,1);
  assert.equal(report.spool.bytes,17);
  assert.equal(report.spool.files,1);
  assert.equal(report.runtimes.bytes,23);
  assert.equal(report.exports.bytes,29);
  assert.ok(report.database.bytes>0);
  assert.ok(report.indexes.bytes>0);
  assert.equal(report.byDay[0].events,1);
  assert.equal(report.byDay[0].source,'macos');
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
