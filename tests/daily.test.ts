import {test} from 'node:test';import assert from 'node:assert/strict';
import {dailyTotals} from '../src/capture/daily.ts';import type {Summary,Interval} from '../src/capture/events.ts';
test('menu bar totals clip to local today, union overlap, and keep independent agents separate',()=>{
 const now=new Date(2026,9,12,12),midnight=new Date(2026,9,12).getTime()/1000;
 const interval=(start:number,end:number,fields:Partial<Interval>={}):Interval=>({start:midnight+start,end:midnight+end,state:'running',proof:'observed',sourceEventIds:[],hostId:'local',sessionId:'s1',...fields});
 const summary:Summary={intervals:[interval(-60,60),interval(20,80),interval(0,30,{sessionId:'s2'}),interval(0,120,{child:true,agentId:'child'}),interval(0,120,{state:'human'}),interval(86400,86430)],sessions:[],coverage:[],unresolved:[],agentSeconds:0,humanSeconds:0,elapsedSeconds:0,childAgentSeconds:0};
 assert.deepEqual(dailyTotals(summary,now),{agentSeconds:110,humanSeconds:120,elapsedSeconds:120});
});
