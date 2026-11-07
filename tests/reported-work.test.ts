import assert from 'node:assert/strict';
import {test} from 'node:test';
import {EventStore} from '../src/capture/store.ts';
import {creditTaskCounters,reportedWorkForDay,type ReportedWorkItem} from '../src/capture/reported-work.ts';
import type {CaptureEvent,Summary} from '../src/capture/events.ts';

const day=1_800_000_000;
function report(id:string,kind:string,at:number,data:Record<string,unknown>):CaptureEvent{
 return {eventId:id,source:'agent_report',kind,observedAt:at,monotonicAt:0,collectorEpoch:'test',provider:'claude',sessionId:'session-one',data};
}

test('counter crosses midnight and remains a declaration with original elapsed start',()=>{
 const start=report('counter','task_start',day-300,{name:'Investigate issue',issueKey:'EZYO-863'});
 const items=reportedWorkForDay([start],day,day+86400,day+120);
 assert.deepEqual(items.map(item=>({kind:item.kind,title:item.title,issueKey:item.issueKey,start:item.start,end:item.end,active:item.active})),[
  {kind:'counter',title:'Investigate issue',issueKey:'EZYO-863',start:day-300,end:day+120,active:true},
 ]);
});

test('stopped counter and point context are distinct timeline items',()=>{
 const events=[report('one','task_start',day+60,{name:'Build'}),report('context','work_context',day+80,{task:'Fix login',issueKey:'EZYO-863',project:'Agent Time'}),report('two','task_stop',day+160,{taskCounterId:'one'})];
 const items=reportedWorkForDay(events,day,day+86400,day+500);
 assert.equal(items.find(item=>item.id==='one')?.end,day+160);
 assert.equal(items.find(item=>item.id==='one')?.active,false);
 assert.equal(items.find(item=>item.id==='context')?.start,items.find(item=>item.id==='context')?.end);
 assert.equal(items.find(item=>item.id==='context')?.project,'Agent Time');
});

test('report query reads only reports within its bounded date range',()=>{
 const store=new EventStore(':memory:');
 store.put(report('one','task_start',day,{name:'Build'}));
 store.put({...report('other','task_start',day+1,{name:'Other'}),source:'hook'});
 store.put(report('late','task_stop',day+86400,{taskCounterId:'one'}));
 assert.deepEqual(store.agentReports(day,day+86400).map(event=>event.eventId),['one']);
 store.close();
});

const counter=(fields:Partial<ReportedWorkItem>):ReportedWorkItem=>({id:'c1',kind:'counter',title:'Audit',provider:'claude',workspaceId:'/w/caex',start:0,end:600,active:false,...fields});
const base=():Summary=>({intervals:[{start:0,end:300,state:'running',proof:'observed',sourceEventIds:[],sessionId:'s1',provider:'claude',workspaceId:'/w/caex'}],unresolved:[],coverage:[],
 sessions:[{key:'s1',sessionId:'s1',provider:'claude',workspaceId:'/w/caex',title:'Claude',state:'stopped',lastObservedAt:300,seconds:300,observedSeconds:300,child:false,proof:'observed'}],
 humanSeconds:0,agentSeconds:300,elapsedSeconds:300,childAgentSeconds:0});

test('task counters credit only time the agent was not already measured',()=>{
 const credited=creditTaskCounters(base(),[counter({})]);
 assert.equal(credited.agentSeconds,600);
 assert.equal(credited.sessions[0].seconds,600);
 const added=credited.intervals.filter(i=>i.attributionSource==='task-counter');
 assert.deepEqual(added.map(i=>[i.start,i.end,i.sessionId]),[[300,600,'s1']]);
});

test('a counter fully covered by measured time adds nothing',()=>{
 const summary=base();
 assert.equal(creditTaskCounters(summary,[counter({end:300})]),summary);
});

test('a counter with no matching session gets a session of its own in its workspace',()=>{
 const credited=creditTaskCounters(base(),[counter({workspaceId:'/w/other',start:1000,end:1600})]);
 const own=credited.sessions.find(session=>session.sessionId==='task-counter:c1');
 assert.equal(own?.workspaceId,'/w/other');
 assert.equal(own?.seconds,600);
 assert.equal(credited.agentSeconds,900);
});

test('contexts are never credited',()=>{
 const summary=base();
 assert.equal(creditTaskCounters(summary,[{...counter({}),kind:'context'}]),summary);
});

test('a counter matches an agent session in a worktree of the same project',()=>{
 const summary=base();summary.sessions[0].workspaceId='orca::/w/caex/.orca/workspaces/fix';summary.intervals[0].workspaceId='orca::/w/caex/.orca/workspaces/fix';
 const credited=creditTaskCounters(summary,[counter({})]);
 assert.equal(credited.sessions.length,1);
 assert.equal(credited.agentSeconds,600);
});

test('a timer its agent never stopped ends with the agent session',()=>{
 const start=report('t1','task_start',day+100,{name:'Audit'});
 const open=reportedWorkForDay([start],day,day+86400,day+5000);
 assert.equal(open[0].active,true);
 const ended=reportedWorkForDay([start],day,day+86400,day+5000,new Map([['claude:session-one',day+700]]));
 assert.deepEqual([ended[0].end,ended[0].active],[day+700,false]);
});

test('a timer stopped from the app ends then; a discarded one disappears',()=>{
 const start=report('t1','task_start',day+100,{name:'Audit'});
 const stopped=reportedWorkForDay([start,report('s1','task_stop',day+400,{taskCounterId:'t1',stoppedBy:'user'})],day,day+86400,day+5000);
 assert.deepEqual([stopped[0].end,stopped[0].active],[day+400,false]);
 assert.equal(reportedWorkForDay([start,report('s2','task_stop',day+400,{taskCounterId:'t1',stoppedBy:'user',discarded:true})],day,day+86400,day+5000).length,0);
});
