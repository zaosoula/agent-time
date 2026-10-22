import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dayConfidence} from '../src/capture/day-confidence.ts';
import type {Summary} from '../src/capture/events.ts';
import type {SourceSnapshot} from '../src/capture/source-state.ts';

const summary:Summary={intervals:[{start:10,end:15,state:'human',proof:'inferred',sourceEventIds:['a','b']}],sessions:[],coverage:[{reason:'Gap',observedAt:12}],unresolved:[],humanSeconds:60,agentSeconds:0,elapsedSeconds:60,childAgentSeconds:0};
const sources:SourceSnapshot[]=[{id:'macos',name:'Mac activity',state:'receiving',lastEvent:15,action:'none',detail:'Receiving'}, {id:'codex',name:'Codex',state:'repair-needed',lastEvent:null,action:'repair-hooks',detail:'Update hooks'}];
test('day confidence keeps Mac delivery separate from a broken agent hook',()=>{
 const day=dayConfidence(summary,sources,['codex'],0,100,true);
 assert.equal(day.observed,1);assert.equal(day.attention,1);assert.equal(day.caveats,1);
 assert.equal(day.sources.find(source=>source.id==='codex')?.state,'attention');
});
test('historical day never claims current hook failure happened then',()=>{
 const day=dayConfidence(summary,sources,['codex'],0,100,false);
 assert.equal(day.attention,0);assert.equal(day.sources.find(source=>source.id==='codex')?.detail,'No credited activity recorded on this day');
});
test('previously verified hook still reports credited activity from the selected day',()=>{
 const withAgent:Summary={...summary,intervals:[...summary.intervals,{start:20,end:25,state:'running',proof:'observed',sourceEventIds:['start','end'],provider:'codex'}]};
 const verified:SourceSnapshot[]=[sources[0]!,{...sources[1]!,state:'verified',action:'none',detail:'Delivered earlier'}];
 const day=dayConfidence(withAgent,verified,['codex'],0,100,true);
 assert.equal(day.sources.find(source=>source.id==='codex')?.detail,'Credited activity recorded on this day');
});
