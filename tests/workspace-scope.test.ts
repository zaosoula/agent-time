import {test} from 'node:test';
import assert from 'node:assert/strict';
import {effectScope,ref} from 'vue';
import {createWorkspaceScope,periodFor,validPeriod} from '../src/ui/workspace-scope.ts';
import {emptyActivityFilters,filterActivity,matchesActivity} from '../src/capture/activity-filter.ts';
import {periodReview,weeklyReview} from '../src/capture/weekly.ts';
import type {Interval,Summary} from '../src/capture/events.ts';
import {dispatchRequest} from '../src/capture/protocol.ts';
const summary=(intervals:Interval[]):Summary=>({intervals,sessions:[],unresolved:[],coverage:[],humanSeconds:0,agentSeconds:0,elapsedSeconds:0,childAgentSeconds:0});
const interval=(day:string,start:number,end:number,extra:Partial<Interval>={}):Interval=>({start:new Date(day+'T00:00:00').getTime()/1000+start,end:new Date(day+'T00:00:00').getTime()/1000+end,state:'human',sourceEventIds:['a','b'],proof:'observed',...extra});
test('shared period follows calendar weeks and months, keeps day focus inside scope, and validates custom ranges',()=>{
 const owner=effectScope(),date=ref('2026-11-13');const scope=owner.run(()=>createWorkspaceScope(date))!;
 scope.setPeriodMode('week');assert.deepEqual(scope.period.value,{mode:'week',from:'2026-11-09',to:'2026-11-15'});assert.equal(date.value,'2026-11-13');
 date.value='2026-11-14';assert.equal(scope.period.value.from,'2026-11-09');
 scope.shiftPeriod(1);assert.equal(date.value,'2026-11-16');assert.equal(scope.period.value.to,'2026-11-22');
 scope.setPeriodMode('month');scope.shiftPeriod(1);assert.deepEqual(scope.period.value,{mode:'month',from:'2026-12-01',to:'2026-12-31'});scope.shiftPeriod(1);assert.equal(scope.period.value.from,'2027-01-01');
 scope.setPeriod('2026-11-06','2026-11-12');assert.equal(date.value,'2026-11-06');date.value='2026-11-10';assert.equal(scope.period.value.mode,'custom');
 const previous={...scope.period.value};assert.equal(scope.setPeriod('2026-02-30','2026-03-01'),false);assert.deepEqual(scope.period.value,previous);
 for(const [from,to]of [['2026-11-12','2026-11-06'],['2026-01-01','2028-01-01']])assert.equal(validPeriod(from,to),false);
 assert.deepEqual(periodFor('month','2028-02-20'),{mode:'month',from:'2028-02-01',to:'2028-02-29'});
 owner.stop();
});
test('day and custom navigation across DST use calendar dates, never fixed 24-hour shifts',()=>{
 const old=process.env.TZ;process.env.TZ='Europe/Paris';
 try{const owner=effectScope(),date=ref('2026-10-25'),scope=owner.run(()=>createWorkspaceScope(date))!;scope.shiftPeriod(1);assert.equal(scope.period.value.from,'2026-10-26');scope.setPeriod('2026-10-24','2026-10-26');scope.shiftPeriod(1);assert.deepEqual(scope.period.value,{mode:'custom',from:'2026-10-27',to:'2026-10-29'});owner.stop();}finally{process.env.TZ=old;}
});
test('activity filtering preserves source intervals and timing while honoring manual unassignment and device identity',()=>{
 const rows=[interval('2026-11-09',0,20,{foregroundName:'Browser',browserDomain:'example.com',browserUrl:'https://example.com/task',workspaceId:'host::/a',hostId:'local'}),interval('2026-11-09',30,40,{foregroundName:'Browser',browserDomain:'example.com',workspaceId:'host::/a',hostId:'remote',userAttribution:'unassigned'}),interval('2026-11-09',0,60,{state:'grouped',workspaceId:'host::/b',hostId:'remote',sessionId:'b'})];
 const source=summary(rows),before=structuredClone(source);
 assert.deepEqual(filterActivity(source,emptyActivityFilters()),rows);
 assert.deepEqual(filterActivity(source,emptyActivityFilters(),'/a'),[rows[0]]);
 assert.deepEqual(filterActivity(source,emptyActivityFilters(),'unassigned'),[rows[1]]);
 assert.deepEqual(filterActivity(source,{...emptyActivityFilters(),device:'remote'}),[rows[1],rows[2]]);
 assert.deepEqual(filterActivity(source,{...emptyActivityFilters(),app:'Browser',site:'example.com',assignment:'assigned'}),[rows[0]]);
 assert.equal(matchesActivity(rows[0]!,{...emptyActivityFilters(),search:'TASK'}),true);
 assert.deepEqual(source,before);assert.equal(filterActivity(source,emptyActivityFilters())[0],rows[0]);
});
test('arbitrary period totals reuse unchanged daily counting and match legacy weekly reports with no filters',()=>{
 const rows=[interval('2026-11-09',0,1,{workspaceId:'host::/a'}),interval('2026-11-09',30,31,{state:'grouped',sessionId:'s',workspaceId:'host::/a'}),interval('2026-11-10',0,20,{workspaceId:'host::/b'})],source=summary(rows),before=structuredClone(source);
 assert.deepEqual(periodReview(source,'2026-11-09','2026-11-15'),weeklyReview(source,'2026-11-09'));
 const period=periodReview(source,'2026-11-09','2026-11-10');
 const days=['2026-11-09','2026-11-10'].map(date=>periodReview(source,date,date));
 for(const key of Object.keys(period.totals)as Array<keyof typeof period.totals>)assert.equal(period.totals[key],days.reduce((sum,d)=>sum+d.totals[key],0));
 const filtered=periodReview(date=>({...source,intervals:filterActivity(source,emptyActivityFilters(),'/a')}),'2026-11-09','2026-11-10');assert.deepEqual(filtered.projects.map(p=>p.project),['/a']);assert.equal(filtered.days[1]!.humanSeconds,0);assert.deepEqual(source,before);
 for(const [from,to]of [['2026-02-30','2026-03-01'],['2026-11-10','2026-11-09'],['2026-01-01','2028-01-01']])assert.throws(()=>periodReview(source,from,to),/Invalid/);
});
test('period report protocol accepts a read-only scope and rejects unknown filters or invalid structures',async()=>{
 const calls:unknown[][]=[];const controller={status:()=>({}),summary:()=>({}),start:async()=>({}),stop:async()=>({}),periodReview:(...args:unknown[])=>{calls.push(args);return {days:[]};}};
 const params={fromDate:'2026-11-06',toDate:'2026-11-12',project:'/a',filters:{device:'local'}};
 assert.deepEqual(await dispatchRequest({id:'scope',method:'period_review',params},controller),{id:'scope',result:{days:[]}});
 assert.deepEqual(calls[0],['2026-11-06','2026-11-12','/a',{...emptyActivityFilters(),device:'local'}]);
 for(const changed of [{filters:true},{filters:null},{filters:[]},{filters:{assignment:'bad'}},{filters:{sql:'anything'}},{project:17},{extra:true}])assert.ok('error'in await dispatchRequest({id:'bad',method:'period_review',params:{...params,...changed}},controller));assert.equal(calls.length,1);
});

test('conflicting human evidence remains unassigned until an explicit assignment resolves it',()=>{
 const conflict=interval('2026-11-09',0,10,{workspaceId:'host::/a',projectPath:'/a',attributionSource:'conflict'}),resolved={...conflict,userAttribution:'assigned' as const};
 assert.equal(filterActivity(summary([conflict]),emptyActivityFilters(),'unassigned').length,1);
 assert.equal(filterActivity(summary([conflict]),{...emptyActivityFilters(),assignment:'assigned'}).length,0);
 assert.equal(filterActivity(summary([resolved]),{...emptyActivityFilters(),assignment:'assigned'},'/a').length,1);
});

test('period reports can yield between days without retaining all summaries or changing any result',async()=>{
 const {periodReviewSteps}=await import('../src/capture/weekly.ts');const dates:string[]=[],source=summary([interval('2026-11-09',0,10,{workspaceId:'host::/a'})]);
 const steps=periodReviewSteps(date=>{dates.push(date);return source;},'2026-11-09','2026-11-11');
 assert.deepEqual(dates,[]);assert.equal(steps.next().done,false);assert.deepEqual(dates,['2026-11-09']);
 await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(dates.length,1);
 assert.equal(steps.next().done,false);assert.equal(dates.length,2);assert.equal(steps.next().done,false);const result=steps.next();assert.equal(result.done,true);assert.deepEqual(result.value,periodReview(source,'2026-11-09','2026-11-11'));
});

test('retained Home filters do not leak into Projects or report evidence',async()=>{
 const {readFileSync}=await import('node:fs'),{computed}=await import('vue');
 const source=readFileSync(new URL('../src/ui/store.ts',import.meta.url),'utf8');
 const block=source.slice(source.indexOf('  const homeFilters='),source.indexOf('  const daySessionIntervals ='));
 const page=ref('today'),pageFilters=ref({today:{...emptyActivityFilters(),app:'Browser'}}),search=ref('retained home search'),rows=[interval('2026-11-09',0,10,{foregroundName:'Browser'}),interval('2026-11-09',20,30,{foregroundName:'Editor'})],data=ref(summary(rows));
 const {default:ts}=await import('typescript');const js=ts.transpileModule(block,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
 const state=new Function('computed','page','pageFilters','search','emptyActivityFilters','filterActivity','summary','dayIntervals',js+';return{homeIntervals,effectiveSearch};')(computed,page,pageFilters,search,emptyActivityFilters,filterActivity,data,ref(rows));
 assert.equal(state.homeIntervals.value.length,1);page.value='reports';assert.equal(state.homeIntervals.value.length,2);assert.equal(state.effectiveSearch.value,'');page.value='projects';assert.equal(state.homeIntervals.value.length,2);page.value='today';assert.equal(state.homeIntervals.value.length,1);assert.equal(state.effectiveSearch.value,'retained home search');assert.equal(pageFilters.value.today.app,'Browser');
});
