import test from 'node:test';import assert from 'node:assert/strict';
import {agentLoadSegments,creditedIntervals,groupTimelineProjects,visualIntervals} from '../src/ui/timeline-groups.ts';
import type {Interval,Session} from '../src/capture/events.ts';

const interval=(start:number,end:number,state:Interval['state'],workspaceId?:string):Interval=>({start,end,state,workspaceId,proof:'inferred',sourceEventIds:[]});
const session=(key:string,child=false):Session=>({key,title:key,child,state:'idle',lastObservedAt:0,seconds:child?3:7,observedSeconds:0,proof:'observed',workspaceId:'host::/projects/alpha'});

test('visual bars join sampling boundaries without joining gaps or different sources',()=>{
 const input=[interval(0,5,'human'),interval(5,10,'human'),interval(12,17,'human')];
 const bars=visualIntervals(input);
 assert.deepEqual(bars.map(i=>[i.start,i.end]),[[0,10],[12,17]]);
 assert.equal(input[0].end,5);
 const apps=visualIntervals([interval(0,5,'human'),{...interval(5,10,'human'),foregroundName:'Other'}],i=>i.foregroundName||'Default');
 assert.equal(apps.length,2);
});
test('credited bars draw the full minute while retaining distinct activity blocks',()=>{
 const input=[interval(0,2,'grouped'),interval(20,22,'grouped'),interval(70,72,'grouped')];
 const grouped=[interval(0,22,'grouped'),input[2]];
 assert.deepEqual(creditedIntervals(grouped).map(i=>[i.start,i.end]),[[0,60],[70,130]]);
 assert.deepEqual(creditedIntervals([interval(0,30,'grouped'),interval(20,50,'grouped')]).map(i=>[i.start,i.end]),[[0,60]]);
 assert.deepEqual(creditedIntervals([input[0],interval(11,13,'grouped')]).map(i=>[i.start,i.end]),[[0,60],[11,71]]);
 assert.equal(grouped[0].end,22);
});

test('project timeline keeps worktree human time when no session can claim it',()=>{
 const parent=session('parent'),child=session('child',true),worktree=interval(0,10,'human','host::/projects/alpha');
 const matched=interval(2,4,'human');
 const groups=groupTimelineProjects([parent,child],[worktree],new Map([[parent.key,[matched]]]),s=>[interval(1,5,'grouped',s.workspaceId)],s=>s.workspaceId!.split('/').at(-1)!,id=>id.split('/').at(-1)!);
 assert.equal(groups.length,1);
 assert.equal(groups[0].name,'alpha');
 assert.deepEqual(groups[0].sessions,[parent,child]);
 assert.equal(groups[0].humanSeconds,60);
 assert.equal(groups[0].macSeconds,60);
 assert.equal(groups[0].browserSeconds,0);
 assert.equal(groups[0].agentSeconds,7);
 assert.equal(groups[0].agent.length,1);
 assert.equal(groups[0].subagent.length,1);
});

test('a project with only worktree-attributed human time has its own timeline row',()=>{
 const human=interval(10,20,'human','host::/projects/beta');
 const groups=groupTimelineProjects([],[human],new Map(),()=>[],()=>'',id=>id.split('/').at(-1)!);
 assert.equal(groups.length,1);assert.equal(groups[0].name,'beta');assert.equal(groups[0].humanSeconds,60);assert.equal(groups[0].sessions.length,0);
});

test('browser and Mac activity appear in distinct project child rows without doubling the parent',()=>{
 const mac={...interval(0,10,'human','host::/projects/alpha'),foregroundBundleId:'com.stablyai.orca',foregroundName:'Orca'};
 const secondMac={...interval(12,20,'human','host::/projects/alpha'),foregroundBundleId:'com.apple.finder',foregroundName:'Finder'};
 const browser={...interval(20,30,'human','host::/projects/alpha'),browserDomain:'example.com',browserUrl:'https://example.com/a',foregroundName:'Brave'};
 const secondPage={...interval(30,40,'human','host::/projects/alpha'),browserDomain:'example.com',browserUrl:'https://example.com/b',foregroundName:'Brave'};
 const local={...interval(50,60,'human','host::/projects/alpha'),browserDomain:'localhost',browserOrigin:'http://localhost:14210',foregroundName:'Brave'};
 const groups=groupTimelineProjects([], [mac,secondMac,browser,secondPage,local],new Map(),()=>[],()=>'',id=>id.split('/').at(-1)!);
 assert.equal(groups[0].mac.length,2);
 assert.equal(groups[0].browser.length,3);
 assert.equal(groups[0].humanSeconds,180);
 assert.equal(groups[0].macSeconds,120);
 assert.equal(groups[0].browserSeconds,120);
 assert.deepEqual(groups[0].macApps.map(row=>row.label),['Finder','Orca']);
 assert.deepEqual(groups[0].websites.map(row=>row.label),['example.com','localhost:14210']);
 assert.equal(groups[0].websites[0].detail,'Brave · 2 pages');
 assert.equal(groups[0].websites[0].seconds,60);
});

test('project workload exposes one agent versus a burst of thirty subagents',()=>{
 const roots=[interval(0,10,'grouped')];
 const children=Array.from({length:30},()=>interval(2,8,'grouped'));
 const steps=agentLoadSegments(roots,children);
 assert.deepEqual(steps.map(({start,end,roots,children,total})=>[start,end,roots,children,total]),[
  [0,2,1,0,1],[2,8,1,30,31],[8,10,1,0,1],
 ]);
 assert.equal(Math.max(...steps.map(step=>step.total)),31);
 const parent=session('root'),subagents=Array.from({length:30},(_,index)=>session(`child-${index}`,true));
 const groups=groupTimelineProjects([parent,...subagents],[],new Map(),s=>[s.child?interval(2,8,'grouped'):interval(0,10,'grouped')],()=> 'alpha',()=> 'alpha');
 assert.equal(groups[0].peakConcurrent,31);
 assert.equal(groups[0].agentSeconds,parent.seconds);
});
test('project credit spans do not inflate observed concurrent agent load',()=>{
 const parent=session('root'),child=session('child',true);
 const groups=groupTimelineProjects([parent,child],[],new Map(),s=>[s.child?interval(20,22,'grouped'):interval(0,2,'grouped')],()=> 'alpha',()=> 'alpha');
 assert.deepEqual(groups[0].creditBars.map(i=>[i.start,i.end]),[[0,80]]);
 assert.deepEqual(groups[0].load.map(i=>[i.start,i.end,i.total]),[[0,2,1],[20,22,1]]);
 assert.equal(groups[0].peakConcurrent,1);
});

test('handoffs at the same instant do not create a false concurrency spike',()=>{
 const steps=agentLoadSegments([interval(0,2,'grouped'),interval(2,4,'grouped')],[]);
 assert.deepEqual(steps.map(({start,end,total})=>[start,end,total]),[[0,4,1]]);
});
