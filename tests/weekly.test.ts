import test from 'node:test';
import assert from 'node:assert/strict';
import {weeklyReview,reviewedCsv} from '../src/capture/weekly.ts';
import type {Summary,Interval} from '../src/capture/events.ts';

test('weekly totals keep concurrent agent work separate from union elapsed time',()=>{
 const start=new Date(2026,9,19).getTime()/1000;
 const interval=(state:Interval['state'],workspaceId:string,sessionId:string,extra:Partial<Interval>={}):Interval=>({start,end:start+60,state,workspaceId,sessionId,hostId:'local',proof:'observed',sourceEventIds:[],...extra});
 const summary:Summary={intervals:[
  interval('grouped','host::/projects/a','a'),interval('grouped','host::/projects/b','b'),
  interval('human','manual::/projects/a','',{userAttribution:'assigned',foregroundName:'Editor'}),
 ],sessions:[],coverage:[],unresolved:[],agentSeconds:0,humanSeconds:0,elapsedSeconds:0,childAgentSeconds:0};
 const week=weeklyReview(summary,'2026-10-19');
 assert.equal(week.totals.agentSeconds,120);
 assert.equal(week.totals.humanSeconds,60);
 assert.equal(week.totals.elapsedSeconds,60);
 assert.equal(week.reviewedEntries.length,1);
 assert.equal(week.projects.find(row=>row.project==='/projects/a')?.reviewedSeconds,60);
 assert.equal(week.days.length,7);
 assert.deepEqual(week.days[0],{date:'2026-10-19',humanSeconds:60,agentSeconds:120,elapsedSeconds:60});
 assert.throws(()=>weeklyReview(summary,'2026-02-30'),/Invalid week start/);
});
test('reviewed export quotes fields and neutralizes spreadsheet formulas',()=>{
 const csv=reviewedCsv([{date:'2026-10-19',start:100,end:160,project:'/projects/a',source:'=HYPERLINK("bad")',seconds:60}]);
 assert.match(csv,/"'=HYPERLINK\(""bad""\)"/);
});
test('accepting a day includes captured project matches in reviewed time without counting unmatched capture',()=>{
 const start=new Date(2026,9,19).getTime()/1000;
 const interval=(workspaceId?:string):Interval=>({start,end:start+60,state:'human',workspaceId,hostId:'local',proof:'inferred',sourceEventIds:['a','b']});
 const summary:Summary={intervals:[interval('observed::/projects/a'),{...interval(),start:start+60,end:start+120}],sessions:[],coverage:[],unresolved:[],agentSeconds:0,humanSeconds:0,elapsedSeconds:0,childAgentSeconds:0};
 assert.equal(weeklyReview(summary,'2026-10-19').reviewedEntries.length,0);
 const accepted=weeklyReview(summary,'2026-10-19',new Set(['2026-10-19']));
 assert.equal(accepted.projects.find(row=>row.project==='/projects/a')?.reviewedSeconds,60);
 assert.equal(accepted.reviewedEntries.length,1);
 assert.equal(accepted.projects.find(row=>row.project==='Unassigned')?.reviewedSeconds,0);
});
