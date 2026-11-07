import assert from 'node:assert/strict';
import {test} from 'node:test';
import {informativeWorker,workerEvent} from '../src/capture/orca.ts';

const worker=(fields:{fresh?:boolean;host?:string;outcome?:string;terminalState?:string})=>workerEvent({dispatchId:'ctx_1',taskId:'task_1',terminalState:fields.terminalState||'released',
 projection:{evidence:{liveStatus:fields.fresh?'fresh':'stale'},outcome:fields.outcome,host:fields.host?{id:fields.host}:undefined,stage:{activity:fields.fresh?'working':undefined}},resource:{}});

test('worker snapshots that cannot credit time, link a hook or close a session are skipped',()=>{
 assert.equal(informativeWorker(worker({})),false);
 assert.equal(informativeWorker(worker({terminalState:'retained'})),false);
 assert.equal(informativeWorker(worker({fresh:true})),true);
 assert.equal(informativeWorker(worker({host:'local'})),true);
 assert.equal(informativeWorker(worker({outcome:'succeeded'})),true);
});
