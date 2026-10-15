import {test} from 'node:test';import assert from 'node:assert/strict';
import {dailyTotals,summaryForDate} from '../src/capture/daily.ts';import type {Summary,Interval} from '../src/capture/events.ts';
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
