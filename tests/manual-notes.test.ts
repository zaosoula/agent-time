import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventStore} from '../src/capture/store.ts';
import {unobservedGaps} from '../src/capture/gaps.ts';
import type {Interval} from '../src/capture/events.ts';

test('manual notes survive restart and do not become captured events',()=>{
 const root=mkdtempSync(join(tmpdir(),'agent-time-note-')),path=join(root,'events.sqlite');
 try{
  let store=new EventStore(path);
  const start=new Date(2026,9,19,10).getTime()/1000;
  const note=store.addManualNote({start,end:start+1800,project:'Project A',note:'Reviewed an offline sketch'});
  assert.equal(store.count(),0);store.close();
  store=new EventStore(path);
  assert.deepEqual(store.manualNotes('2026-10-19'),[note]);
  assert.equal(store.removeManualNote(note.id),true);
  assert.deepEqual(store.manualNotes('2026-10-19'),[]);
  assert.throws(()=>store.addManualNote({start,end:start+1800,project:'',note:''}),/Invalid manual note/);
  store.close();
 }finally{rmSync(root,{recursive:true});}
});
test('unobserved gaps use the union of overlapping captured intervals',()=>{
 const interval=(start:number,end:number):Interval=>({start,end,state:'human',proof:'observed',sourceEventIds:[]});
 assert.deepEqual(unobservedGaps([interval(0,600),interval(100,700),interval(1000,1300)]),[{start:700,end:1000,seconds:300}]);
});
