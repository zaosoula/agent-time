import { test } from 'node:test';import assert from 'node:assert/strict';
import { unionSeconds, summarize } from '../src/capture/correlate.ts';
import type { CaptureEvent } from '../src/capture/events.ts';
const e=(id:string,time:number,kind:string,fields:Partial<CaptureEvent>={}):CaptureEvent=>({eventId:id,source:'hook',kind,observedAt:time,monotonicAt:time,collectorEpoch:'a',...fields});
const worker=(id:string,time:number,dispatchId='d1',runId='r1',state='working',outcome='in_progress')=>e(id,time,'worker',{source:'orca',hostId:'local',terminalHandle:'t1',workspaceId:'ws',dispatchId,runId,taskId:'task-'+dispatchId,data:{state,outcome,fresh:true}});
test('surface settings fence open activity instead of bridging disabled periods',()=>{
 const root={sessionId:'s1',terminalHandle:'t1',hostId:'local',provider:'claude'};
 const s=summarize([e('start',0,'tool_start',root),e('settings',5,'capture_settings',{source:'capture',data:{previous:{claudeHooks:true},surfaces:{claudeHooks:false}}}),e('end',3600,'tool_end',root)]);
 assert.equal(s.agentSeconds,0);assert.ok(s.coverage.length);
 const untouched=summarize([e('start',0,'tool_start',root),e('settings',5,'capture_settings',{source:'capture',data:{previous:{orcaPolling:true},surfaces:{orcaPolling:false}}}),e('end',20,'tool_end',root)]);
 assert.equal(untouched.agentSeconds,20);
});
test('hooks preceding the first worker poll promote into one Dispatch and overlapping time counts once',()=>{
 const root={sessionId:'s1',terminalHandle:'t1',hostId:'local'};
 const events=[e('s',0,'session_start',root),e('early1',1,'tool_start',{...root,data:{toolId:'early'}}),e('early2',2,'tool_end',{...root,data:{toolId:'early'}}),e('p',20,'prompt_submitted',root),e('t1',21,'tool_start',{...root,data:{toolId:'long'}}),worker('w1',25),worker('w2',30),worker('w3',35),e('t2',41,'tool_end',{...root,data:{toolId:'long'}}),e('stop',42,'response_stop',root),worker('done',45,'d1','r1','done','succeeded')];
 const s=summarize(events);assert.equal(s.sessions.length,1);assert.equal(s.sessions[0]?.dispatchId,'d1');assert.equal(s.sessions[0]?.sessionId,'s1');assert.equal(s.sessions[0]?.seconds,21);assert.equal(s.agentSeconds,21);
 assert.equal(summarize([...events,worker('idle',3600,'d1','r1','done','succeeded')]).agentSeconds,21);
});
test('a tool opened before Dispatch binding closes in the promoted session',()=>{
 const root={sessionId:'s1',terminalHandle:'t1',hostId:'local'};
 const s=summarize([e('start',0,'tool_start',{...root,data:{toolId:'A'}}),worker('w',20),e('bind',21,'session_start',root),e('end',25,'tool_end',{...root,data:{toolId:'A'}})]);
 assert.equal(s.sessions.length,1);assert.equal(s.sessions[0]?.seconds,25);assert.equal(s.agentSeconds,25);assert.equal(s.unresolved.length,0);
});
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
test('native child lifecycle is inclusive detail and late session-end does not create a duplicate root',()=>{
 const root={sessionId:'s1',terminalHandle:'t1',hostId:'local',workspaceId:'ws'};
 const s=summarize([worker('w1',0),e('h1',1,'tool_start',root),e('h2',4,'tool_end',root),e('c1',1,'child_start',{...root,agentId:'child'}),e('c2',4,'child_stop',{...root,agentId:'child'}),worker('w2',5,'d1','r1','unknown','succeeded'),e('h3',6,'session_end',root)]);
 assert.equal(s.sessions.filter(x=>!x.child).length,1);assert.equal(s.sessions.find(x=>!x.child)?.state,'completed');assert.equal(s.childAgentSeconds,3);
});
test('parallel tools close only their own IDs; an unmatched old tool cannot bridge a gap',()=>{
 const root={sessionId:'s1',terminalHandle:'t1',hostId:'local',workspaceId:'ws'};
 const s=summarize([e('a1',0,'tool_start',{...root,data:{toolId:'A'}}),e('b1',1,'tool_start',{...root,data:{toolId:'B'}}),e('a2',2,'tool_end',{...root,data:{toolId:'A'}}),e('b2',10,'tool_end',{...root,data:{toolId:'B'}})]);
 assert.equal(s.agentSeconds,10);
 const g=summarize([e('1',0,'tool_start',{...root,data:{toolId:'old'}}),e('2',3600,'tool_start',{...root,data:{toolId:'new'}}),e('3',3605,'tool_end',{...root,data:{toolId:'new'}})]);assert.equal(g.agentSeconds,5);assert.ok(g.unresolved.length||g.coverage.length);
});
test('sleep fences native child lifetime; late events never steal a reused terminal',()=>{
 const root={sessionId:'s1',terminalHandle:'t1',hostId:'local',workspaceId:'ws'};
 const c=summarize([e('1',0,'child_start',{...root,agentId:'child'}),e('2',5,'sleep',{source:'macos'}),e('3',3600,'child_stop',{...root,agentId:'child'})]);assert.equal(c.childAgentSeconds,0);assert.ok(c.coverage.length);
 const s=summarize([worker('w1',0),e('1',1,'tool_start',root),e('2',2,'tool_end',root),worker('w2',10,'d1','r1','unknown','succeeded'),worker('w3',11,'d2','r1'),e('3',11.5,'tool_start',{...root,sessionId:'s2'}),e('4',12,'session_end',root),e('5',15,'tool_end',{...root,sessionId:'s2'})]);
 assert.equal(s.sessions.find(x=>x.dispatchId==='d2')?.sessionId,'s2');assert.equal(s.sessions.find(x=>x.dispatchId==='d2')?.seconds,3.5);
});
test('late old-session closure cannot shorten the next Dispatch tool',()=>{
 const root={sessionId:'s1',terminalHandle:'t1',hostId:'local',workspaceId:'ws'};
 const s=summarize([worker('w1',0),e('1',1,'tool_start',root),e('2',2,'tool_end',root),worker('w2',10,'d1','r1','unknown','succeeded'),worker('w3',11,'d2','r1'),e('3',11.5,'tool_start',{...root,sessionId:'s2'}),e('4',12,'session_end',root),e('5',15,'tool_end',{...root,sessionId:'s2'})]);
 assert.equal(s.sessions.find(x=>x.dispatchId==='d2')?.sessionId,'s2');assert.equal(s.sessions.find(x=>x.dispatchId==='d2')?.seconds,3.5);
});
test('human intervals attach to one stable Orca tab and leave switches unassigned',()=>{
 const activity=(id:string,time:number,tabId:string,workspaceId:string)=>e(id,time,'activity',{source:'macos',workspaceId,terminalHandle:'term-'+tabId,data:{foregroundBundleId:'com.stablyai.orca',idleSeconds:0,tabId,tabTitle:'Tab '+tabId}});
 const s=summarize([activity('a',0,'a','w'),activity('b',2,'a','w'),activity('c',4,'b','w'),activity('d',6,'b','w')]);
 assert.equal(s.humanSeconds,6);const intervals=s.intervals.filter(i=>i.state==='human');assert.equal(intervals[0].tabId,'a');assert.equal(intervals[1].tabId,undefined);assert.equal(intervals[2].tabId,'b');
});
