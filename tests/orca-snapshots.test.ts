import assert from 'node:assert/strict';
import {test} from 'node:test';
import {informativeWorker,workerEvent} from '../src/capture/orca.ts';
import {summarize} from '../src/capture/correlate.ts';
import {compactHealthEvents} from '../src/capture/health.ts';

const worker=(fields:{fresh?:boolean;host?:string;outcome?:string;terminalState?:string})=>workerEvent({dispatchId:'ctx_1',taskId:'task_1',terminalState:fields.terminalState||'released',
 projection:{evidence:{liveStatus:fields.fresh?'fresh':'stale'},outcome:fields.outcome,host:fields.host?{id:fields.host}:undefined,stage:{activity:fields.fresh?'working':undefined}},resource:{}});

test('worker snapshots that cannot credit time, link a hook or close a session are skipped',()=>{
 assert.equal(informativeWorker(worker({})),false);
 assert.equal(informativeWorker(worker({terminalState:'retained'})),false);
 assert.equal(informativeWorker(worker({fresh:true})),true);
 assert.equal(informativeWorker(worker({host:'local'})),true);
 assert.equal(informativeWorker(worker({outcome:'succeeded'})),true);
});

test('worker capture bounds stored metadata while preserving timing and stale-health suppression',()=>{
 const input={dispatchId:'dispatch',taskId:'task',terminalState:'x'.repeat(2048),projection:{host:{id:'local'},stage:{activity:'working'},outcome:'in_progress',evidence:{liveStatus:'fresh'},parent:{unused:'x'.repeat(2048)},liveness:{verdict:'x'.repeat(2048)}},resource:{terminalHandle:'term'}};
 const events=[0,5].map(at=>({...workerEvent(input),eventId:`sample-${at}`,observedAt:100+at,monotonicAt:at,collectorEpoch:'epoch'}));
 assert.ok(Buffer.byteLength(JSON.stringify(events[0]!.data))<160);
 const summary=summarize(events);assert.equal(summary.agentSeconds,60);assert.equal(summary.sessions[0]!.observedSeconds,5);
 const legacy=events.map(event=>({...event,data:{...event.data,parent:input.projection.parent,liveness:input.projection.liveness.verdict,terminalState:input.terminalState,takeover:false}}));
 assert.deepEqual(summarize(events),summarize(legacy));
 const stale=worker({host:'local'});assert.equal(stale.data?.fresh,false);assert.deepEqual(compactHealthEvents([stale]),[]);
 const takeover=workerEvent({...input,resource:{...input.resource,retainedReason:'user_takeover'}});assert.equal(takeover.data?.takeover,true);
});
