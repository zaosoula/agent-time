import {test} from 'node:test';
import assert from 'node:assert/strict';
import {calculateBilling,renderBillingExport} from '../src/capture/billing-engine.ts';
import type {BillingProject,BillingDayInput,BillingPolicy} from '../src/capture/billing-types.ts';
const project=(mode?:'minutes'|'seconds'):BillingProject=>({id:'p',name:'Project',aliases:[],sources:{repositories:[],workspaceIds:[],reportedProjects:[]},timezone:'UTC',policies:[{id:'v1',effectiveFrom:'2026-11-01',basis:'overlapMergedWall',countingMode:mode,currency:'EUR',hourlyRate:'60',agentOnlyHourlyRate:null,agentWeight:'1',rounding:{minutes:1,mode:'down',scope:'period'},dailyCapMinutes:null,presenceWindowMinutes:null,aiFees:{mode:'none'}}]});
const day=(date='2026-11-01',start=0,end=86400):BillingDayInput=>({date,start,end,spans:[],excluded:[],humanMessages:[],presenceEvidenceAvailable:true,usage:[],usageComplete:true,coverageComplete:true});
const human=(start:number,end:number)=>({start,end,kind:'human' as const,projectId:'p'});
const agent=(start:number,end:number,sessionKey='root')=>({start,end,kind:'agent' as const,sessionKey,projectId:'p'});
const run=(p:BillingProject,days:BillingDayInput[])=>calculateBilling(p,days,{fromDate:'2026-11-01',toDate:'2026-11-02'});
test('minutes count each eligible contiguous block while seconds and absent legacy stay raw',()=>{
 const d=day();d.spans=[human(0,2),human(10,12)];
 for(const mode of [undefined,'seconds'] as const){const r=run(project(mode),[d]);assert.equal(r.totals.eligibleSeconds,4);assert.equal(r.totals.rawEligibleSeconds,4);assert.equal(r.totals.countingAdjustmentSeconds,0);}
 const r=run(project('minutes'),[d]);assert.equal(r.totals.humanActiveSeconds,4);assert.equal(r.totals.eligibleSeconds,120);assert.equal(r.totals.countingAdjustmentSeconds,116);assert.equal(r.totals.roundingSeconds,0);assert.equal(r.calculationVersion,4);
});
test('minutes union concurrent project sources and keep cumulative native executions separate',()=>{
 const d=day();d.spans=[agent(0,2,'root'),agent(0,2,'child'),agent(1,3,'root')];
 const p=project('minutes');assert.equal(run(p,[d]).totals.eligibleSeconds,60);
 p.policies[0]!.basis='weightedAgentRunning';assert.equal(run(p,[d]).totals.eligibleSeconds,120);assert.equal(run(p,[d]).totals.agentRunningSeconds,5);
});
test('midnight extends the same open minute block and policies terminate it',()=>{
 const a=day(),b=day('2026-11-02',86400,172800);a.spans=[human(86399,86400)];b.spans=[human(86400,86401)];
 const p=project('minutes'),r=run(p,[a,b]);assert.equal(r.totals.eligibleSeconds,60);assert.deepEqual(r.days.map(d=>d.eligibleSeconds),[30,30]);
 p.policies.push({...p.policies[0]!,id:'v2',effectiveFrom:'2026-11-02'});assert.equal(run(p,[a,b]).totals.eligibleSeconds,120);
});
test('cuts and presence are applied before minute blocks form',()=>{
 const p=project('minutes'),d=day();p.policies[0]!.presenceWindowMinutes=1;d.humanMessages=[0,120];d.spans=[agent(0,200)];d.excluded=[{start:20,end:40,reason:'locked'}];
 const r=run(p,[d]);assert.equal(r.totals.rawEligibleSeconds,100);assert.equal(r.totals.eligibleSeconds,180);assert.equal(r.totals.agentWallSeconds,180);
 d.presenceEvidenceAvailable=false;assert.equal(run(p,[d]).totals.eligibleSeconds,0);
});
test('one shared production block distributes credit before separate rates and weighting',()=>{
 const p=project('minutes'),d=day();Object.assign(p.policies[0]!,{basis:'weightedAgentOnly',agentWeight:'1/2',hourlyRate:'120',agentOnlyHourlyRate:'30'});d.spans=[human(0,10),agent(10,30)];
 const r=run(p,[d]);assert.equal(r.totals.rawEligibleSeconds,20);assert.equal(r.totals.eligibleSeconds,40);assert.equal(r.totals.countingAdjustmentSeconds,20);assert.equal(r.totals.billableSeconds,0);
 p.policies[0]!.rounding.mode='up';assert.equal(run(p,[d]).totals.timeAmount,'1.25');
 p.policies[0]!.dailyCapMinutes=1;p.policies[0]!.rounding.minutes=15;assert.equal(run(p,[d]).totals.billableSeconds,60);
});
test('human basis ignores autonomous work; minute inputs reject reverse chronology only',()=>{
 const p=project('minutes'),a=day(),b=day('2026-11-02',86400,172800);p.policies[0]!.basis='humanActive';a.spans=[human(0,2),agent(2,100)];assert.equal(run(p,[a]).totals.eligibleSeconds,60);
 assert.throws(()=>run(p,[b,a]),/chronolog/i);delete p.policies[0]!.countingMode;assert.doesNotThrow(()=>run(p,[b,a]));
});
test('exports disclose counting and legacy fallback without mutating old snapshots',()=>{
 const p=project('minutes'),d=day();d.spans=[human(0,2)];const r=run(p,[d]);p.policies.push({...p.policies[0]!,id:'v2',effectiveFrom:'2026-11-02',countingMode:'seconds'});const mixed=run(p,[d,day('2026-11-02',86400,172800)]);
 for(const format of ['csv','markdown'] as const){const text=renderBillingExport(mixed,format);assert.match(text,/Counting mode/);assert.match(text,/mixed/);assert.match(text,/Raw eligible seconds/);assert.match(text,/Counting adjustment seconds/);}
 delete r.projectSnapshot.policies[0]!.countingMode;for(const amounts of [...r.days,r.totals]){delete amounts.rawEligibleSeconds;delete amounts.countingAdjustmentSeconds;}const before=JSON.stringify(r);assert.match(renderBillingExport(r,'csv'),/legacy seconds/);assert.equal(JSON.stringify(r),before);
});

test('a future minute revision preserves unordered historical seconds inputs',()=>{
 const p=project(),a=day(),b=day('2026-11-02',86400,172800);a.spans=[human(0,2)];
 p.policies.push({...p.policies[0]!,id:'future',effectiveFrom:'2026-12-01',countingMode:'minutes'});
 assert.equal(run(p,[b,a]).totals.eligibleSeconds,2);
});

test('fractional human-agent boundaries retain one exact minute and save without negative adjustment',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {EventStore}=await import('../src/capture/store.ts');const {BillingStore}=await import('../src/capture/billing-store.ts');
 const p=project('minutes');p.policies[0]!.rounding.mode='up';
 const base=1794456000,d=day('2026-11-01',base,base+86400);d.spans=[human(base,base+2.007),agent(base+2.007,base+60)];
 const r=run(p,[d]);assert.equal(r.totals.eligibleSeconds,60);assert.equal(r.totals.billableSeconds,60);assert.equal(r.totals.countingAdjustmentSeconds,0);
 const output=mkdtempSync(join(tmpdir(),'billing-counting-fraction-')),store=new EventStore(join(output,'events.sqlite'));
 try{const billing=new BillingStore(store.database);billing.saveReport(r);assert.equal(billing.report(r.reportId)?.totals.countingAdjustmentSeconds,0);}finally{store.close();rmSync(output,{recursive:true,force:true});}
});
