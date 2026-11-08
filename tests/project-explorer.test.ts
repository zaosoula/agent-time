import assert from 'node:assert/strict';
import {test} from 'node:test';
import {activityPreview,explorerSessions} from '../src/ui/project-explorer.ts';
import type {Interval} from '../src/capture/events.ts';
import type {DaySession,TimelineSessionRow} from '../src/ui/store.ts';

const session=(key:string,seconds:number,fields:Partial<DaySession>={}):DaySession=>({key,title:key,state:'completed',lastObservedAt:0,seconds,observedSeconds:seconds,child:false,proof:'observed',provider:'claude',sessionId:key,...fields});
const bar=(start:number,end:number,child=false):Interval=>({start,end,state:'grouped',proof:'observed',sourceEventIds:[],child});
const row=(s:DaySession,bars:Interval[],parentKey:string|null=null):TimelineSessionRow=>({session:s,parentKey,childCount:0,bars,creditBars:bars,childBars:[],childCreditBars:[]});

test('a session sums its own and its subagents measured time without re-deriving it',()=>{
 const main=session('main',600),childA=session('a',300,{child:true,agentId:'a',sessionId:'main'}),childB=session('b',120,{child:true,agentId:'b',sessionId:'main'});
 const [only]=explorerSessions({rows:[row(main,[bar(0,600)]),row(childA,[bar(100,400,true)],'main'),row(childB,[bar(200,320,true)],'main')]},new Map());
 assert.equal(only!.agentSeconds,1020);
 assert.equal(only!.subagents,2);
 assert.equal(only!.peak,3);
 // Overlapping subagent time is inside the main window, so elapsed is the window once.
 assert.equal(only!.wallSeconds,600);
 assert.deepEqual(only!.executions.map(item=>item.key),['main','a','b']);
});

test('session human time appears only when capture links it to that session',()=>{
 const sessions=explorerSessions({rows:[row(session('s1',60),[bar(0,60)]),row(session('s2',60),[bar(100,160)])]},new Map([['s1',[{...bar(0,120),state:'human'}]]]));
 assert.equal(sessions[0]!.humanSeconds,120);
 assert.equal(sessions[1]!.humanSeconds,null);
});

test('reported work is attached by session and never added to measured time',()=>{
 const reported=[{id:'r',kind:'counter' as const,title:'Audit',provider:'claude',sessionId:'s1',start:0,end:9999,active:false},{id:'x',kind:'context' as const,title:'Other',provider:'claude',sessionId:'s2',start:0,end:0,active:false}];
 const [one]=explorerSessions({rows:[row(session('s1',60),[bar(0,60)])]},new Map(),reported);
 assert.deepEqual(one!.reported.map(item=>item.id),['r']);
 assert.equal(one!.agentSeconds,60);
});

test('subagents whose parent is not on the day still appear as their own session',()=>{
 const sessions=explorerSessions({rows:[row(session('orphan',30,{child:true}),[bar(0,30,true)],'gone')]},new Map());
 assert.equal(sessions.length,1);
 assert.equal(sessions[0]!.agentSeconds,30);
});

test('the activity preview keeps the peak of each bucket',()=>{
 const preview=activityPreview([{start:0,end:100,roots:1,children:0,total:1},{start:50,end:60,roots:1,children:4,total:5}],0,400,4);
 assert.deepEqual(preview,[5,0,0,0]);
});
