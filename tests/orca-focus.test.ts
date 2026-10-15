import {test} from 'node:test';import assert from 'node:assert/strict';
import {resolveOrcaTab,tabIndexFromTerminalList} from '../src/capture/orca-focus.ts';
import * as focus from '../src/capture/orca-focus.ts';
import type {Session,Interval} from '../src/capture/events.ts';
const tab=(worktreeId:string,tabId:string,title:string,leafId:string,handle:string)=>({worktreeId,root:{tabs:[{tabId,title,activeLeafId:leafId,panes:{type:'terminal',handle,leafId}}]}});
test('selected visible tab resolves to stable workspace, tab and active split leaf',()=>{
 const index=tabIndexFromTerminalList({ok:true,result:{visualLayouts:[tab('w1','tab-1','Write spec','leaf-1','term-1'),tab('w2','tab-2','Other tab','leaf-2','term-2')]}});
 assert.deepEqual(resolveOrcaTab('Write spec',index),{workspaceId:'w1',tabId:'tab-1',leafId:'leaf-1',terminalHandle:'term-1',title:'Write spec'});
});
test('duplicate or unmatched labels stay unassigned and never inherit a previous tab',()=>{
 const index=tabIndexFromTerminalList({ok:true,result:{visualLayouts:[tab('w1','a','Review','leaf-1','term-1'),tab('w2','b','Review','leaf-2','term-2')]}});
 assert.equal(resolveOrcaTab('Review',index),null);assert.equal(resolveOrcaTab('Other',index),null);
});
test('a split tab uses the active leaf and refuses a missing active pane',()=>{
 const layout={worktreeId:'w',root:{tabs:[{tabId:'t',title:'Review',activeLeafId:'right',panes:{type:'split',first:{type:'terminal',leafId:'left',handle:'term-left'},second:{type:'terminal',leafId:'right',handle:'term-right'}}}]}};
 const index=tabIndexFromTerminalList({ok:true,result:{visualLayouts:[layout]}});
 assert.equal(resolveOrcaTab('Review',index)?.terminalHandle,'term-right');
 layout.root.tabs[0].activeLeafId='missing';assert.equal(resolveOrcaTab('Review',tabIndexFromTerminalList({ok:true,result:{visualLayouts:[layout]}})),null);
});
test('human activity joins a session only with unique terminal and workspace evidence',()=>{
 const session=(key:string,sessionId:string):Session=>({key,sessionId,hostId:'local',workspaceId:'ws',terminalHandle:'term',title:'Session',state:'idle',lastObservedAt:150,seconds:100,observedSeconds:10,child:false,proof:'observed'});
 const interval=(start:number,end:number,state:Interval['state'],sessionId?:string,workspaceId='ws',terminalHandle='term'):Interval=>({start,end,state,proof:'observed',sourceEventIds:[],hostId:'local',sessionId,workspaceId,terminalHandle,child:false});
 const first=session('session:local:a','a'),second=session('session:local:b','b');
 const spans=[interval(0,100,'grouped','a'),interval(50,150,'grouped','b')];
 const early=interval(10,20,'human',undefined),ambiguous=interval(60,70,'human',undefined),wrong=interval(10,20,'human',undefined,'other');
 const fn=(focus as unknown as {humanIntervalsForSession?: (s:Session,sessions:Session[],intervals:Interval[])=>Interval[]}).humanIntervalsForSession;
 assert.deepEqual(fn?.(first,[first,second],[...spans,early,ambiguous,wrong]),[early]);
});
test('an Orca title without a terminal matches only one overlapping session',()=>{
 const make=(key:string,sessionId:string,title:string,start:number,end:number):{session:Session;span:Interval}=>({session:{key,sessionId,hostId:'local',workspaceId:'ws',title,state:'idle',lastObservedAt:end,seconds:end-start,observedSeconds:0,child:false,proof:'observed'},span:{start,end,state:'grouped',proof:'inferred',sourceEventIds:[],hostId:'local',sessionId,workspaceId:'ws',child:false}});
 const first=make('session:local:a','a','Track my agent session like a timesheet',0,100),second=make('session:local:b','b','Another task',50,150);
 const human:Interval={start:60,end:70,state:'human',proof:'inferred',sourceEventIds:[],hostId:'local',tabTitle:'Track my agent session like a',child:false};
 assert.deepEqual(focus.humanIntervalsForSession(first.session,[first.session,second.session],[first.span,second.span,human]),[human]);
 const duplicate=make('session:local:c','c','Track my agent session like a second time',40,90);
 assert.deepEqual(focus.humanIntervalsForSession(first.session,[first.session,second.session,duplicate.session],[first.span,second.span,duplicate.span,human]),[]);
});
