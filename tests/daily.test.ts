import {test} from 'node:test';import assert from 'node:assert/strict';
import {dailyCaptureIssues,dailyTotals,recentWorkingAgentCount,summaryForDate,workingAgentCount} from '../src/capture/daily.ts';import type {CaptureEvent,Summary,Interval,Session} from '../src/capture/events.ts';
test('daily caveats show only this day and omit the static Orca scope notice',()=>{
 const base:Summary={intervals:[],sessions:[],coverage:[{reason:'Poll failed',observedAt:100},{reason:'Old failure',observedAt:99},{reason:'Only this Orca host is observed; remote execution has not been verified',observedAt:101}],unresolved:[{reason:'Open tool',observedAt:199},{reason:'Tomorrow',observedAt:200}],agentSeconds:0,humanSeconds:0,elapsedSeconds:0,childAgentSeconds:0};
 assert.deepEqual(dailyCaptureIssues(base,100,200).map(issue=>issue.reason),['Poll failed','Open tool']);
});
test('working agent snapshot matches My day recency and stops on pause',()=>{
 const now=new Date(2026,9,19,12),at=now.getTime()/1000;
 const session=(state:string,lastObservedAt:number,seconds=60):Session=>({key:state+lastObservedAt,title:'Agent',state,lastObservedAt,seconds,observedSeconds:seconds,child:false,proof:'observed'});
 const summary:Summary={intervals:[],sessions:[session('working',at-5),session('running',at-19),session('working',at-20),session('waiting',at-2),session('working',at-1,0)],coverage:[],unresolved:[],agentSeconds:0,humanSeconds:0,elapsedSeconds:0,childAgentSeconds:0};
 assert.equal(workingAgentCount(summary,now),2);
 assert.equal(workingAgentCount(summary,now,false),0);
});
test('recent worker and hook evidence counts live agents without double-counting a terminal',()=>{
 const now=1000;
 const event=(id:string,at:number,source:string,kind:string,extra:Partial<CaptureEvent>={}):CaptureEvent=>({eventId:id,source,kind,observedAt:at,monotonicAt:at,collectorEpoch:'epoch',...extra});
 const workers=[event('root',995,'orca','worker',{hostId:'local',dispatchId:'d1',terminalHandle:'t1',data:{fresh:true,state:'working'}}),event('old',970,'orca','worker',{hostId:'local',dispatchId:'d2',terminalHandle:'t2',data:{fresh:true,state:'working'}})];
 const hooks=[event('root-tool',996,'hook','tool_start',{hostId:'local',sessionId:'s1',terminalHandle:'t1'}),event('child-tool',997,'hook','tool_start',{hostId:'local',sessionId:'s1',agentId:'child',terminalHandle:'t1'}),event('ended',998,'hook','tool_end',{hostId:'local',sessionId:'s2',terminalHandle:'t2'})];
 assert.equal(recentWorkingAgentCount(workers,hooks,now),2);
 assert.equal(recentWorkingAgentCount(workers,[...hooks,event('unbound',999,'hook','tool_start',{hostId:'local',sessionId:'unbound'})],now),2);
 assert.equal(recentWorkingAgentCount(workers,[...hooks,event('same-dispatch',999,'hook','tool_start',{hostId:'local',sessionId:'s3',dispatchId:'d1'})],now),2);
 assert.equal(recentWorkingAgentCount([event('done',999,'orca','worker',{hostId:'local',dispatchId:'d1',terminalHandle:'t1',data:{fresh:false,state:'done'}}),...workers],hooks,now),2);
 assert.equal(recentWorkingAgentCount(workers,hooks,1020),0);
});
test('menu bar totals clip to local today, union overlap, and keep independent agents separate',()=>{
 const now=new Date(2026,9,12,12),midnight=new Date(2026,9,12).getTime()/1000;
 const interval=(start:number,end:number,fields:Partial<Interval>={}):Interval=>({start:midnight+start,end:midnight+end,state:'running',proof:'observed',sourceEventIds:[],hostId:'local',sessionId:'s1',...fields});
 const summary:Summary={intervals:[interval(-60,60),interval(20,80),interval(0,30,{sessionId:'s2'}),interval(0,120,{child:true,agentId:'child'}),interval(0,120,{state:'human'}),interval(86400,86430)],sessions:[],coverage:[],unresolved:[],agentSeconds:0,humanSeconds:0,elapsedSeconds:0,childAgentSeconds:0};
 assert.deepEqual(dailyTotals(summary,now),{agentSeconds:180,humanSeconds:120,elapsedSeconds:120});
});
test('daily agent time includes completed turns without adding overlapping tool time twice',()=>{
 const now=new Date(2026,9,12,12),midnight=new Date(2026,9,12).getTime()/1000;
 const interval=(start:number,end:number,state:Interval['state']):Interval=>({start:midnight+start,end:midnight+end,state,proof:'observed',sourceEventIds:[],hostId:'local',sessionId:'s1'});
 const summary:Summary={intervals:[interval(0,60,'turn'),interval(10,20,'running')],sessions:[],coverage:[],unresolved:[],agentSeconds:0,humanSeconds:0,elapsedSeconds:0,childAgentSeconds:0};
 assert.equal(dailyTotals(summary,now).agentSeconds,60);
});
test('daily totals group short gaps inside a session',()=>{
 const now=new Date(2026,9,12,12),midnight=new Date(2026,9,12).getTime()/1000;
 const interval=(start:number,end:number):Interval=>({start:midnight+start,end:midnight+end,state:'running',proof:'observed',sourceEventIds:[],hostId:'local',sessionId:'s1'});
 const summary:Summary={intervals:[interval(0,1),interval(50,51)],sessions:[],coverage:[],unresolved:[],agentSeconds:0,humanSeconds:0,elapsedSeconds:0,childAgentSeconds:0};
 assert.equal(dailyTotals(summary,now).agentSeconds,60);
});
test('day summary clips intervals without changing full history or crossing local midnight',()=>{
 const start=new Date(2026,9,14).getTime()/1000,next=new Date(2026,9,15).getTime()/1000;
 const interval=(from:number,to:number,state:Interval['state'],extra:Partial<Interval>={}):Interval=>({start:from,end:to,state,proof:'observed',sourceEventIds:[],sessionId:'root',...extra});
 const full:Summary={intervals:[interval(start-30,start+30,'grouped'),interval(start+20,start+40,'human'),interval(start+60,start+70,'grouped',{child:true,agentId:'child'}),interval(next,next+10,'human')],sessions:[],coverage:[],unresolved:[],agentSeconds:999,humanSeconds:999,elapsedSeconds:999,childAgentSeconds:999};
 const day=summaryForDate(full,'2026-10-14');
 assert.deepEqual(day.intervals.map(i=>[i.start,i.end]),[[start,start+30],[start+20,start+40],[start+60,start+70]]);
 assert.equal(full.intervals[0].start,start-30);
 assert.equal(day.agentSeconds,60);assert.equal(day.humanSeconds,60);assert.equal(day.childAgentSeconds,60);
 assert.throws(()=>summaryForDate(full,'2026-02-30'),/Invalid summary date/);
});
test('day summary sends only relevant sessions and caveats while retaining health reasons',()=>{
 const start=new Date(2026,9,14).getTime()/1000,next=new Date(2026,9,15).getTime()/1000;
 const interval=(sessionId:string,from:number,to:number,child=false,agentId?:string):Interval=>({start:from,end:to,state:'grouped',proof:'observed',sourceEventIds:[],hostId:'local',sessionId,child,agentId});
 const session=(key:string,sessionId:string,lastObservedAt:number,child=false,agentId?:string):Session=>({key,title:key,state:'idle',lastObservedAt,seconds:60,observedSeconds:60,child,proof:'observed',hostId:'local',sessionId,agentId});
 const full:Summary={intervals:[interval('crosses',start-10,start+10),interval('child',start+20,start+40,true,'a'),interval('old',start-80,start-60)],sessions:[session('crosses','crosses',start-10),session('child','child',next+10,true,'a'),session('today-no-duration','today',start+30),session('old','old',start-70),session('other-host','crosses',start-10)],coverage:[{reason:'Today',observedAt:start+5},{reason:'Historical',observedAt:start-10}],unresolved:[{reason:'Tomorrow',observedAt:next+5}],agentSeconds:0,humanSeconds:0,elapsedSeconds:0,childAgentSeconds:0};
 full.sessions[4]!.hostId='remote';
 const day=summaryForDate(full,'2026-10-14');
 assert.deepEqual(day.sessions.map(s=>s.key),['crosses','child','today-no-duration']);
 assert.deepEqual(day.coverage.map(i=>i.reason),['Today']);
 assert.deepEqual(day.unresolved,[]);
 assert.deepEqual(day.issueReasons,['Today','Historical','Tomorrow']);
 assert.equal(full.sessions.length,5);assert.equal(full.coverage.length,2);
});
