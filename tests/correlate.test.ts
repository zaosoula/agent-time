import { test } from 'node:test';import assert from 'node:assert/strict';
import { unionSeconds, summarize } from '../src/capture/correlate.ts';
import type { CaptureEvent } from '../src/capture/events.ts';
const e=(id:string,time:number,kind:string,fields:Partial<CaptureEvent>={}):CaptureEvent=>({eventId:id,source:'hook',kind,observedAt:time,monotonicAt:time,collectorEpoch:'a',...fields});
const worker=(id:string,time:number,dispatchId='d1',runId='r1',state='working',outcome='in_progress')=>e(id,time,'worker',{source:'orca',hostId:'local',terminalHandle:'t1',workspaceId:'ws',dispatchId,runId,taskId:'task-'+dispatchId,data:{state,outcome,fresh:true}});
test('capture caveats retain the observation time for daily review',()=>{
 const summary=summarize([e('gap',123,'coverage',{source:'orca',data:{reason:'Poll failed'}}),e('end',456,'tool_end',{sessionId:'s',terminalHandle:'t',hostId:'local'})]);
 assert.deepEqual(summary.coverage.map(issue=>issue.observedAt),[123]);
 assert.deepEqual(summary.unresolved.map(issue=>issue.observedAt),[456]);
});
test('a completed prompt-to-response turn includes reasoning gaps without double-counting tool execution',()=>{
 const root={sessionId:'s1',terminalHandle:'t1',hostId:'local',provider:'codex'};
 const s=summarize([e('prompt',0,'prompt_submitted',root),e('tool-start',10,'tool_start',{...root,data:{toolId:'a'}}),e('tool-end',20,'tool_end',{...root,data:{toolId:'a'}}),e('stop',60,'response_stop',root)]);
 assert.equal(s.agentSeconds,60);
 assert.equal(s.sessions[0]?.seconds,60);
 assert.equal(s.sessions[0]?.observedSeconds,10);
 assert.deepEqual(s.intervals.filter(i=>i.state==='turn').map(i=>[i.start,i.end]),[[0,60]]);
});
test('tracked actions in one session include gaps up to one minute, but keep longer gaps open',()=>{
 const root={sessionId:'s1',terminalHandle:'t1',hostId:'local',provider:'codex'};
 const s=summarize([e('a1',0,'tool_start',{...root,data:{toolId:'a'}}),e('a2',1,'tool_end',{...root,data:{toolId:'a'}}),e('b1',50,'tool_start',{...root,data:{toolId:'b'}}),e('b2',51,'tool_end',{...root,data:{toolId:'b'}}),e('c1',112,'tool_start',{...root,data:{toolId:'c'}}),e('c2',113,'tool_end',{...root,data:{toolId:'c'}})]);
 assert.equal(s.sessions[0]?.seconds,120);
 assert.equal(s.sessions[0]?.observedSeconds,3);
 assert.equal(s.agentSeconds,120);
 assert.deepEqual(s.intervals.filter(i=>i.state==='grouped').map(i=>[i.start,i.end]),[[0,51],[112,113]]);
});
test('a completed turn excludes a known permission wait before one-minute grouping',()=>{
 const root={sessionId:'s1',terminalHandle:'t1',hostId:'local',provider:'claude'};
 const s=summarize([e('p',0,'prompt_submitted',root),e('a1',10,'tool_start',{...root,data:{toolId:'a'}}),e('a2',20,'tool_end',{...root,data:{toolId:'a'}}),e('wait',30,'waiting',root),e('b1',330,'tool_start',{...root,data:{toolId:'b'}}),e('b2',340,'tool_end',{...root,data:{toolId:'b'}}),e('stop',350,'response_stop',root)]);
 assert.equal(s.agentSeconds,120);
 assert.equal(s.sessions[0]?.observedSeconds,20);
 assert.deepEqual(s.intervals.filter(i=>i.state==='grouped').map(i=>[i.start,i.end]),[[0,30],[330,350]]);
});
test('an unmatched prompt does not grow across a new prompt, interruption, or capture boundary',()=>{
 const root={sessionId:'s1',terminalHandle:'t1',hostId:'local',provider:'codex'};
 const s=summarize([e('first',0,'prompt_submitted',root),e('second',60,'prompt_submitted',root),e('stop',90,'response_stop',root),e('third',100,'prompt_submitted',root),e('interrupt',120,'interrupted',root),e('fourth',130,'prompt_submitted',root),e('sleep',140,'sleep',{source:'macos'}),e('late',1000,'response_stop',root)]);
 assert.equal(s.agentSeconds,60);
 assert.deepEqual(s.intervals.filter(i=>i.state==='turn').map(i=>[i.start,i.end]),[[60,90]]);
 assert.ok(s.unresolved.length>=2);
});
test('surface settings fence open activity instead of bridging disabled periods',()=>{
 const root={sessionId:'s1',terminalHandle:'t1',hostId:'local',provider:'claude'};
 const s=summarize([e('start',0,'tool_start',root),e('settings',5,'capture_settings',{source:'capture',data:{previous:{claudeHooks:true},surfaces:{claudeHooks:false}}}),e('end',3600,'tool_end',root)]);
 assert.equal(s.agentSeconds,60);assert.ok(s.coverage.length);
 const untouched=summarize([e('start',0,'tool_start',root),e('settings',5,'capture_settings',{source:'capture',data:{previous:{orcaPolling:true},surfaces:{orcaPolling:false}}}),e('end',20,'tool_end',root)]);
 assert.equal(untouched.agentSeconds,60);
});
test('hooks preceding the first worker poll promote into one Dispatch and overlapping time counts once',()=>{
 const root={sessionId:'s1',terminalHandle:'t1',hostId:'local'};
 const events=[e('s',0,'session_start',root),e('early1',1,'tool_start',{...root,data:{toolId:'early'}}),e('early2',2,'tool_end',{...root,data:{toolId:'early'}}),e('p',20,'prompt_submitted',root),e('t1',21,'tool_start',{...root,data:{toolId:'long'}}),worker('w1',25),worker('w2',30),worker('w3',35),e('t2',41,'tool_end',{...root,data:{toolId:'long'}}),e('stop',42,'response_stop',root),worker('done',45,'d1','r1','done','succeeded')];
 const s=summarize(events);assert.equal(s.sessions.length,1);assert.equal(s.sessions[0]?.dispatchId,'d1');assert.equal(s.sessions[0]?.sessionId,'s1');assert.equal(s.sessions[0]?.seconds,60);assert.equal(s.sessions[0]?.observedSeconds,21);assert.equal(s.agentSeconds,60);
 assert.equal(summarize([...events,worker('idle',3600,'d1','r1','done','succeeded')]).agentSeconds,60);
});
test('a tool opened before Dispatch binding closes in the promoted session',()=>{
 const root={sessionId:'s1',terminalHandle:'t1',hostId:'local'};
 const s=summarize([e('start',0,'tool_start',{...root,data:{toolId:'A'}}),worker('w',20),e('bind',21,'session_start',root),e('end',25,'tool_end',{...root,data:{toolId:'A'}})]);
 assert.equal(s.sessions.length,1);assert.equal(s.sessions[0]?.seconds,60);assert.equal(s.agentSeconds,60);assert.equal(s.unresolved.length,0);
});
test('elapsed union counts overlaps once and rejects reversed intervals',()=>{assert.equal(unionSeconds([[0,60],[20,80]]),80);assert.equal(unionSeconds([[0,60],[60,90]]),90);assert.throws(()=>unionSeconds([[5,1]]));});
test('a shared cwd cannot identify a session',()=>{const s=summarize([e('1',1,'prompt_submitted',{sessionId:'s1',cwd:'/shared'})]);assert.ok(s.unresolved.length);assert.equal(s.agentSeconds,0);});
test('same-workspace workers group by Run and Dispatch with explicit terminal binding',()=>{
 const s=summarize([worker('w1',0),worker('w2',5),e('h1',1,'session_start',{sessionId:'s1',terminalHandle:'t1',hostId:'local'}),worker('w3',10,'d2','r2'),worker('w4',15,'d2','r2')]);
 assert.equal(s.sessions.filter(x=>x.dispatchId).length,2);assert.equal(s.sessions.find(x=>x.dispatchId==='d1')?.sessionId,'s1');assert.equal(s.agentSeconds,120);assert.equal(s.elapsedSeconds,120);
});
test('retained/takeover/completed attempts never continue accruing time',()=>{
 const s=summarize([worker('w1',0),worker('w2',5),worker('w3',10,'d1','r1','unknown','succeeded'),worker('w4',100,'d1','r1','working','succeeded')]);assert.equal(s.agentSeconds,60);
 const t=summarize([worker('w1',0),{...worker('w2',5),data:{state:'working',fresh:true,takeover:true}}]);assert.equal(t.agentSeconds,0);
});
test('gaps and epoch changes produce coverage issues, not overnight time',()=>{
 const s=summarize([worker('w1',0),worker('w2',3600)]);assert.equal(s.agentSeconds,0);assert.ok(s.coverage.length);
 const t=summarize([worker('w1',0),{...worker('w2',5),collectorEpoch:'b'}]);assert.equal(t.agentSeconds,0);
});
test('root and child tool intervals are separate; duplicate replay is stable',()=>{
 const root={sessionId:'s1',terminalHandle:'t1',hostId:'local',workspaceId:'ws'};
 const events=[e('1',0,'tool_start',{...root,data:{toolId:'a'}}),e('2',10,'tool_end',{...root,data:{toolId:'a'}}),e('3',2,'child_start',{...root,agentId:'child'}),e('4',3,'tool_start',{...root,agentId:'child',data:{toolId:'b'}}),e('5',8,'tool_end',{...root,agentId:'child',data:{toolId:'b'}})];
 const s=summarize(events);assert.equal(s.agentSeconds,60);assert.equal(s.childAgentSeconds,60);assert.equal(s.elapsedSeconds,60);assert.deepEqual(summarize([...events,...events]),s);
});
test('permission wait and resume are separate; rollback is unknown',()=>{
 const root={sessionId:'s1',terminalHandle:'t1',hostId:'local',workspaceId:'ws'};
 const s=summarize([e('1',0,'tool_start',root),e('2',5,'waiting',root),e('3',10,'tool_start',root),e('4',15,'response_stop',root)]);assert.equal(s.agentSeconds,120);assert.equal(s.intervals.filter(x=>x.state==='waiting').length,1);
 const t=summarize([e('1',10,'tool_start',root),{...e('2',5,'tool_end',root),monotonicAt:20}]);assert.equal(t.agentSeconds,0);assert.ok(t.coverage.length);
});
test('human time is a bounded foreground estimate and idle is excluded',()=>{
 const activity=(id:string,time:number,idle:number)=>e(id,time,'activity',{source:'macos',data:{foregroundBundleId:'test',idleSeconds:idle}});
 const s=summarize([activity('1',0,0),activity('2',5,0),activity('3',10,400),activity('4',15,400)]);assert.equal(s.humanSeconds,60);assert.equal(s.agentSeconds,0);
 assert.equal(summarize([activity('1',0,90),activity('2',5,90)],{idleThreshold:60}).humanSeconds,0);
 assert.equal(summarize([activity('1',0,90),activity('2',5,90)],{idleThreshold:120}).humanSeconds,60);
});
test('agent idle suspends a silent turn and resumes at the next observed event',()=>{
 const root={sessionId:'s1',terminalHandle:'t1',hostId:'local',provider:'codex'};
 const silent=summarize([e('p',0,'prompt_submitted',root),e('stop',600,'response_stop',root)]);
 assert.equal(silent.agentSeconds,300);
 assert.equal(summarize([e('p',0,'prompt_submitted',root),e('stop',600,'response_stop',root)],{agentIdleThreshold:120}).agentSeconds,120);
 const resumed=summarize([e('p',0,'prompt_submitted',root),e('start',600,'tool_start',{...root,data:{toolId:'a'}}),e('end',610,'tool_end',{...root,data:{toolId:'a'}}),e('stop',620,'response_stop',root)]);
 assert.equal(resumed.agentSeconds,360);
 assert.deepEqual(resumed.intervals.filter(i=>i.state==='grouped').map(i=>[i.start,i.end]),[[0,300],[600,620]]);
 const near=summarize([e('p',0,'prompt_submitted',root),e('start',330,'tool_start',{...root,data:{toolId:'a'}}),e('end',340,'tool_end',{...root,data:{toolId:'a'}}),e('stop',340,'response_stop',root)]);
 assert.deepEqual(near.intervals.filter(i=>i.state==='grouped').map(i=>[i.start,i.end]),[[0,300],[330,340]]);
});
test('native child lifecycle is inclusive detail and late session-end does not create a duplicate root',()=>{
 const root={sessionId:'s1',terminalHandle:'t1',hostId:'local',workspaceId:'ws'};
 const s=summarize([worker('w1',0),e('h1',1,'tool_start',root),e('h2',4,'tool_end',root),e('c1',1,'child_start',{...root,agentId:'child'}),e('c2',4,'child_stop',{...root,agentId:'child'}),worker('w2',5,'d1','r1','unknown','succeeded'),e('h3',6,'session_end',root)]);
 assert.equal(s.sessions.filter(x=>!x.child).length,1);assert.equal(s.sessions.find(x=>!x.child)?.state,'completed');assert.equal(s.childAgentSeconds,60);
});
test('parallel tools close only their own IDs; an unmatched old tool cannot bridge a gap',()=>{
 const root={sessionId:'s1',terminalHandle:'t1',hostId:'local',workspaceId:'ws'};
 const s=summarize([e('a1',0,'tool_start',{...root,data:{toolId:'A'}}),e('b1',1,'tool_start',{...root,data:{toolId:'B'}}),e('a2',2,'tool_end',{...root,data:{toolId:'A'}}),e('b2',10,'tool_end',{...root,data:{toolId:'B'}})]);
 assert.equal(s.agentSeconds,60);
 const g=summarize([e('1',0,'tool_start',{...root,data:{toolId:'old'}}),e('2',3600,'tool_start',{...root,data:{toolId:'new'}}),e('3',3605,'tool_end',{...root,data:{toolId:'new'}})]);assert.equal(g.agentSeconds,120);assert.ok(g.unresolved.length||g.coverage.length);
});
test('sleep fences native child lifetime; late events never steal a reused terminal',()=>{
 const root={sessionId:'s1',terminalHandle:'t1',hostId:'local',workspaceId:'ws'};
 const c=summarize([e('1',0,'child_start',{...root,agentId:'child'}),e('2',5,'sleep',{source:'macos'}),e('3',3600,'child_stop',{...root,agentId:'child'})]);assert.equal(c.childAgentSeconds,0);assert.ok(c.coverage.length);
 const s=summarize([worker('w1',0),e('1',1,'tool_start',root),e('2',2,'tool_end',root),worker('w2',10,'d1','r1','unknown','succeeded'),worker('w3',11,'d2','r1'),e('3',11.5,'tool_start',{...root,sessionId:'s2'}),e('4',12,'session_end',root),e('5',15,'tool_end',{...root,sessionId:'s2'})]);
 assert.equal(s.sessions.find(x=>x.dispatchId==='d2')?.sessionId,'s2');assert.equal(s.sessions.find(x=>x.dispatchId==='d2')?.seconds,60);
});
test('late old-session closure cannot shorten the next Dispatch tool',()=>{
 const root={sessionId:'s1',terminalHandle:'t1',hostId:'local',workspaceId:'ws'};
 const s=summarize([worker('w1',0),e('1',1,'tool_start',root),e('2',2,'tool_end',root),worker('w2',10,'d1','r1','unknown','succeeded'),worker('w3',11,'d2','r1'),e('3',11.5,'tool_start',{...root,sessionId:'s2'}),e('4',12,'session_end',root),e('5',15,'tool_end',{...root,sessionId:'s2'})]);
 assert.equal(s.sessions.find(x=>x.dispatchId==='d2')?.sessionId,'s2');assert.equal(s.sessions.find(x=>x.dispatchId==='d2')?.seconds,60);
});
test('human intervals attach to one stable Orca tab and leave switches unassigned',()=>{
 const activity=(id:string,time:number,tabId:string,workspaceId:string)=>e(id,time,'activity',{source:'macos',workspaceId,terminalHandle:'term-'+tabId,data:{foregroundBundleId:'com.stablyai.orca',idleSeconds:0,tabId,tabTitle:'Tab '+tabId}});
 const s=summarize([activity('a',0,'a','w'),activity('b',2,'a','w'),activity('c',4,'b','w'),activity('d',6,'b','w')]);
 assert.equal(s.humanSeconds,60);const intervals=s.intervals.filter(i=>i.state==='human');assert.equal(intervals[0].tabId,'a');assert.equal(intervals[1].tabId,undefined);assert.equal(intervals[2].tabId,'b');
});
test('unmatched Orca tab labels survive on bounded human intervals for unique session matching',()=>{
 const activity=(id:string,time:number)=>e(id,time,'activity',{source:'macos',data:{foregroundBundleId:'com.stablyai.orca',idleSeconds:0,orcaSelectedTabTitle:'Track my agent session like a'}});
 const s=summarize([activity('a',0),activity('b',2)]);
 assert.equal(s.intervals.find(i=>i.state==='human')?.tabTitle,'Track my agent session like a');
});
test('stable Orca worktree is attributed even without a terminal match, but worktree switches remain unassigned',()=>{
 const activity=(id:string,time:number,workspaceId:string)=>e(id,time,'activity',{source:'macos',workspaceId,data:{foregroundBundleId:'com.stablyai.orca',idleSeconds:0}});
 const s=summarize([activity('a',0,'w1'),activity('b',2,'w1'),activity('c',4,'w2'),activity('d',6,'w2')]);
 const intervals=s.intervals.filter(i=>i.state==='human');
 assert.equal(s.humanSeconds,60);
 assert.deepEqual(intervals.map(i=>i.workspaceId),['w1',undefined,'w2']);
 assert.ok(intervals.every(i=>i.tabId===undefined));
});
test('browser time belongs to a page only while its URL stays foreground',()=>{
 const activity=(id:string,time:number,bundle:string,domain?:string,url?:string)=>e(id,time,'activity',{source:'macos',data:{foregroundBundleId:bundle,browserDomain:domain,browserUrl:url,browserTitle:url?'Page '+id:undefined,idleSeconds:0}});
 const summary=summarize([activity('a',0,'com.apple.Safari','github.com','https://github.com/a'),activity('b',2,'com.apple.Safari','github.com','https://github.com/a'),activity('c',4,'com.apple.Safari','github.com','https://github.com/b'),activity('d',6,'com.google.Chrome','github.com','https://github.com/b')]);
 const human=summary.intervals.filter(i=>i.state==='human');
 assert.equal(summary.humanSeconds,60);
 assert.deepEqual(human.map(i=>i.browserDomain),['github.com','github.com',undefined]);
 assert.deepEqual(human.map(i=>i.browserUrl),['https://github.com/a',undefined,undefined]);
 assert.equal(human[0]?.browserBundleId,'com.apple.Safari');
});
test('human project attribution explains stable website evidence and flags conflicts',()=>{
 const activity=(id:string,time:number,project:string)=>e(id,time,'activity',{source:'macos',workspaceId:`web::${project}`,data:{foregroundBundleId:'com.apple.Safari',browserDomain:'example.test',browserUrl:'https://example.test/page',idleSeconds:0,websiteAttribution:{source:'port_process',projectPath:project,detail:'Local port owner'}}});
 const intervals=summarize([activity('a',0,'/project/a'),activity('b',2,'/project/a'),activity('c',4,'/project/b')]).intervals.filter(i=>i.state==='human');
 assert.equal(intervals[0]?.attributionReason,'Local port owner');
 assert.equal(intervals[0]?.attributionSource,'port_process');
 assert.equal(intervals[1]?.workspaceId,undefined);
 assert.equal(intervals[1]?.attributionReason,'Conflicting project observations');
});
test('one-minute credit groups short bursts once, and separates bursts beyond one minute',()=>{
 const root={sessionId:'s1',terminalHandle:'t1',hostId:'local'};
 const burst=(id:string,start:number)=>[e(id+'-start',start,'tool_start',{...root,data:{toolId:id}}),e(id+'-end',start+2,'tool_end',{...root,data:{toolId:id}})];
 assert.equal(summarize(burst('a',0)).agentSeconds,60);
 assert.equal(summarize([...burst('a',0),...burst('b',20)]).agentSeconds,60);
 assert.equal(summarize([...burst('a',0),...burst('b',70)]).agentSeconds,120);
});
test('a permission wait splits agent credit and observed human approval gets its own minute',()=>{
 const root={sessionId:'s1',terminalHandle:'t1',hostId:'local'};
 const activity=(id:string,time:number)=>e(id,time,'activity',{source:'macos',data:{foregroundBundleId:'com.stablyai.orca',idleSeconds:0}});
 const summary=summarize([e('start',0,'tool_start',root),e('wait',2,'waiting',root),activity('human-a',20),activity('human-b',22),e('resume',30,'tool_start',root),e('end',32,'tool_end',root)]);
 assert.equal(summary.agentSeconds,120);
 assert.equal(summary.humanSeconds,60);
 assert.deepEqual(summary.intervals.filter(i=>i.state==='grouped').map(i=>[i.start,i.end]),[[0,2],[30,32]]);
});
test('an unresolved tool receives one provisional minute, replaced by its measured close',()=>{
 const root={sessionId:'s1',terminalHandle:'t1',hostId:'local'};
 const start=e('start',0,'tool_start',{...root,data:{toolId:'a'}});
 const pending=summarize([start]);
 assert.equal(pending.agentSeconds,60);
 assert.equal(pending.sessions[0]?.observedSeconds,0);
 assert.ok(pending.unresolved.some(i=>i.reason.includes('provisional minute')));
 const closed=summarize([start,e('end',90,'tool_end',{...root,data:{toolId:'a'}})]);
 assert.equal(closed.agentSeconds,120);
 assert.equal(closed.sessions[0]?.observedSeconds,90);
 assert.ok(!closed.unresolved.some(i=>i.reason.includes('provisional minute')));
});
test('concurrent sessions keep separate agent credit while elapsed overlap is counted once',()=>{
 const first={sessionId:'s1',terminalHandle:'t1',hostId:'local'};
 const second={sessionId:'s2',terminalHandle:'t2',hostId:'local'};
 const summary=summarize([e('a1',0,'tool_start',first),e('b1',0,'tool_start',second),e('a2',2,'tool_end',first),e('b2',2,'tool_end',second)]);
 assert.equal(summary.agentSeconds,120);
 assert.equal(summary.elapsedSeconds,60);
});
