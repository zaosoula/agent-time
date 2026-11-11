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

test('task metadata survives reconciliation and usage is own-task declared data',()=>{
 const events=[report('a','task_start',day,{name:'TVA',issueKey:'T-9716',project:'KANZen',agentIdentity:{id:'cto',name:'CTO'},parentTaskCounterId:'parent',billable:false,leaseSeconds:900}),report('b','task_stop',day+60,{taskCounterId:'a',usage:{inputTokens:100,outputTokens:20,cost:0.02,currency:'USD',source:'provider-response'}})];
 const item=reportedWorkForDay(events,day,day+86400,day+100)[0];
 assert.equal(item.project,'KANZen');assert.equal(item.issueKey,'T-9716');assert.equal(item.agentIdentity?.id,'cto');assert.equal(item.parentTaskCounterId,'parent');assert.equal(item.billable,false);assert.equal(item.usage?.cost,0.02);assert.equal(item.status,'completed');
});

test('expired leases stop at last confirmed activity; a late explicit stop recovers declared duration',()=>{
 const start=report('a','task_start',day,{name:'Crash',leaseSeconds:900});
 const heartbeat=report('h','task_heartbeat',day+600,{taskCounterId:'a'});
 let item=reportedWorkForDay([start,heartbeat],day,day+86400,day+1600)[0];
 assert.equal(item.active,false);assert.equal(item.status,'interrupted');assert.equal(item.end,day+600);
 item=reportedWorkForDay([start,heartbeat,report('s','task_stop',day+1700,{taskCounterId:'a'})],day,day+86400,day+1800)[0];
 assert.equal(item.status,'completed');assert.equal(item.end,day+1700);
});

test('parent and child counters on one native execution do not duplicate credit, distinct business agents stay distinct',()=>{
 const summary=base();const same=[counter({id:'parent',sessionId:'s1'}),counter({id:'child',sessionId:'s1',parentTaskCounterId:'parent',start:100,end:500})];
 assert.equal(creditTaskCounters(summary,same).agentSeconds,600);
 const declared=[counter({id:'a',workspaceId:'/elsewhere',agentIdentity:{id:'cto'},start:1000,end:1060}),counter({id:'b',workspaceId:'/elsewhere',agentIdentity:{id:'cfo'},start:1000,end:1060})];
 assert.equal(creditTaskCounters(summary,declared).agentSeconds,420);
});

test('parent and child sharing an unobserved native execution merge declared overlap',()=>{
 const summary:Summary={intervals:[],sessions:[],unresolved:[],coverage:[],humanSeconds:0,agentSeconds:0,elapsedSeconds:0,childAgentSeconds:0};
 const credited=creditTaskCounters(summary,[counter({id:'p',sessionId:'native',start:0,end:600}),counter({id:'c',sessionId:'native',parentTaskCounterId:'p',start:60,end:300})]);
 assert.equal(credited.agentSeconds,600);assert.equal(credited.sessions.length,1);
});

test('late native session end cannot revive an expired lease',()=>{
 const start=report('a','task_start',day,{name:'Crash',leaseSeconds:900});
 const items=reportedWorkForDay([start],day,day+86400,day+7400,new Map([['claude:session-one',day+7300]]));
 assert.equal(items[0].status,'interrupted');assert.equal(items[0].end,day);
});

test('a stop after midnight confirms the previous day instead of retrospectively expiring it',()=>{
 const start=report('a','task_start',day-300,{name:'Cross midnight',leaseSeconds:900});
 const stop=report('s','task_stop',day+100,{taskCounterId:'a'});
 const item=reportedWorkForDay([start,stop],day-86400,day,day+2000)[0];
 assert.equal(item.end,day);assert.equal(item.status,'completed');
});

test('native session end shortly after midnight confirms the prior-day counter',()=>{
 const start=report('a','task_start',day-600,{name:'Night task',leaseSeconds:900});
 const stop={...report('end','session_end',day+60,{}),source:'hook'};
 const item=reportedWorkForDay([start,stop],day-86400,day,day+2000)[0];
 assert.equal(item.end,day);assert.equal(item.status,'session-ended');
});
