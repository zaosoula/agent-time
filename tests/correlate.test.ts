import { test } from 'node:test';import assert from 'node:assert/strict';
import { unionSeconds, summarize } from '../src/capture/correlate.ts';
import type { CaptureEvent } from '../src/capture/events.ts';
const e=(id:string,time:number,kind:string,fields:Partial<CaptureEvent>={}):CaptureEvent=>({eventId:id,source:'hook',kind,observedAt:time,monotonicAt:time,collectorEpoch:'a',...fields});
const worker=(id:string,time:number,dispatchId='d1',runId='r1',state='working',outcome='in_progress')=>e(id,time,'worker',{source:'orca',hostId:'local',terminalHandle:'t1',workspaceId:'ws',dispatchId,runId,taskId:'task-'+dispatchId,data:{state,outcome,fresh:true}});
test('elapsed union counts overlaps once and rejects reversed intervals',()=>{assert.equal(unionSeconds([[0,60],[20,80]]),80);assert.equal(unionSeconds([[0,60],[60,90]]),90);assert.throws(()=>unionSeconds([[5,1]]));});
test('a shared cwd cannot identify a session',()=>{const s=summarize([e('1',1,'prompt_submitted',{sessionId:'s1',cwd:'/shared'})]);assert.ok(s.unresolved.length);assert.equal(s.agentSeconds,0);});
test('same-workspace workers group by Run and Dispatch with explicit terminal binding',()=>{
 const s=summarize([worker('w1',0),worker('w2',5),e('h1',1,'session_start',{sessionId:'s1',terminalHandle:'t1',hostId:'local'}),worker('w3',10,'d2','r2'),worker('w4',15,'d2','r2')]);
 assert.equal(s.sessions.filter(x=>x.dispatchId).length,2);assert.equal(s.sessions.find(x=>x.dispatchId==='d1')?.sessionId,'s1');assert.equal(s.agentSeconds,10);assert.equal(s.elapsedSeconds,10);
});
test('retained/takeover/completed attempts never continue accruing time',()=>{
 const s=summarize([worker('w1',0),worker('w2',5),worker('w3',10,'d1','r1','unknown','succeeded'),worker('w4',100,'d1','r1','working','succeeded')]);assert.equal(s.agentSeconds,5);
 const t=summarize([worker('w1',0),{...worker('w2',5),data:{state:'working',fresh:true,takeover:true}}]);assert.equal(t.agentSeconds,0);
});
test('gaps and epoch changes produce coverage issues, not overnight time',()=>{
 const s=summarize([worker('w1',0),worker('w2',3600)]);assert.equal(s.agentSeconds,0);assert.ok(s.coverage.length);
 const t=summarize([worker('w1',0),{...worker('w2',5),collectorEpoch:'b'}]);assert.equal(t.agentSeconds,0);
});
test('root and child tool intervals are separate; duplicate replay is stable',()=>{
 const root={sessionId:'s1',terminalHandle:'t1',hostId:'local',workspaceId:'ws'};
 const events=[e('1',0,'tool_start',{...root,data:{toolId:'a'}}),e('2',10,'tool_end',{...root,data:{toolId:'a'}}),e('3',2,'child_start',{...root,agentId:'child'}),e('4',3,'tool_start',{...root,agentId:'child',data:{toolId:'b'}}),e('5',8,'tool_end',{...root,agentId:'child',data:{toolId:'b'}})];
 const s=summarize(events);assert.equal(s.agentSeconds,10);assert.equal(s.childAgentSeconds,5);assert.equal(s.elapsedSeconds,10);assert.deepEqual(summarize([...events,...events]),s);
});
test('permission wait and resume are separate; rollback is unknown',()=>{
 const root={sessionId:'s1',terminalHandle:'t1',hostId:'local',workspaceId:'ws'};
 const s=summarize([e('1',0,'tool_start',root),e('2',5,'waiting',root),e('3',10,'tool_start',root),e('4',15,'response_stop',root)]);assert.equal(s.agentSeconds,10);assert.equal(s.intervals.filter(x=>x.state==='waiting').length,1);
 const t=summarize([e('1',10,'tool_start',root),{...e('2',5,'tool_end',root),monotonicAt:20}]);assert.equal(t.agentSeconds,0);assert.ok(t.coverage.length);
});
test('human time is a bounded foreground estimate and idle is excluded',()=>{
 const activity=(id:string,time:number,idle:number)=>e(id,time,'activity',{source:'macos',data:{foregroundBundleId:'test',idleSeconds:idle}});
 const s=summarize([activity('1',0,0),activity('2',5,0),activity('3',10,400),activity('4',15,400)]);assert.equal(s.humanSeconds,5);assert.equal(s.agentSeconds,0);
});
