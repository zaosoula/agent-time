import assert from 'node:assert/strict';
import {test} from 'node:test';
import {EventStore} from '../src/capture/store.ts';
import {reportedWorkForDay} from '../src/capture/reported-work.ts';
import type {CaptureEvent} from '../src/capture/events.ts';

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
