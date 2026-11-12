import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {EventStore} from '../src/capture/store.ts';
import {makeEvent} from '../src/capture/events.ts';
import {BillingStore} from '../src/capture/billing-store.ts';
import {billingForProject} from '../src/capture/billing-service.ts';
import type {BillingProject} from '../src/capture/billing-types.ts';

test('new minute-default policy and second revision produce separate immutable reports from the same capture',()=>{
 const output=mkdtempSync(join(tmpdir(),'agent-time-counting-integration-')),events=new EventStore(join(output,'events.sqlite')),store=new BillingStore(events.database);
 const project:BillingProject={id:'client',name:'Client',aliases:[],sources:{repositories:['/fixture/client'],workspaceIds:[],reportedProjects:[]},timezone:'Europe/Paris',policies:[{id:'minute-default',effectiveFrom:'2026-01-01',basis:'overlapMergedWall',currency:'EUR',hourlyRate:'75',agentOnlyHourlyRate:null,agentWeight:'1',rounding:{minutes:1,mode:'nearest',scope:'period'},dailyCapMinutes:null,presenceWindowMinutes:null,aiFees:{mode:'none'}}]};
 try{
  const saved=store.saveProject(project);assert.equal(saved.policies[0]?.countingMode,'minutes');
  const at=Date.parse('2026-11-10T10:00:00+01:00')/1000;
  for(const sessionId of ['one','two'])for(const offset of [0,600])for(const [kind,duration] of [['tool_start',0],['tool_end',20]] as const)events.put(makeEvent('hook',kind,{provider:'claude',sessionId,hostId:'local',cwd:'/fixture/client',observedAt:at+offset+duration,data:{toolId:`t-${offset}`}}));
  const request={project:'client',fromDate:'2026-11-10',toDate:'2026-11-10',detail:'daily' as const};
  const minute=billingForProject(output,request).report;
  assert.equal(minute.totals.overlapMergedWallSeconds,40);assert.equal(minute.totals.agentRunningSeconds,80);
  assert.equal(minute.totals.rawEligibleSeconds,40);assert.equal(minute.totals.countingAdjustmentSeconds,80);assert.equal(minute.totals.eligibleSeconds,120);assert.equal(minute.totals.timeAmount,'2.50');assert.deepEqual(minute.countingModes,['minutes']);
  const frozen=JSON.stringify(store.report(minute.reportId));
  store.saveProject({...saved,policies:[...saved.policies,{...saved.policies[0]!,id:'second-revision',countingMode:'seconds'}]},saved.revision);
  const seconds=billingForProject(output,request).report;
  assert.equal(seconds.totals.overlapMergedWallSeconds,40);assert.equal(seconds.totals.rawEligibleSeconds,40);assert.equal(seconds.totals.countingAdjustmentSeconds,0);assert.equal(seconds.totals.eligibleSeconds,40);assert.equal(seconds.totals.roundingSeconds,20);assert.equal(seconds.totals.timeAmount,'1.25');assert.deepEqual(seconds.countingModes,['seconds']);
  assert.notEqual(seconds.reportId,minute.reportId);assert.equal(JSON.stringify(store.report(minute.reportId)),frozen);
  const exported=billingForProject(output,{...request,reportId:minute.reportId,format:'csv'});
  assert.equal(exported.report.totals.timeAmount,'2.50');const csv=readFileSync(exported.export!.path,'utf8');assert.ok(csv.includes('minutes'));assert.ok(csv.includes('Counting'));
 }finally{events.close();rmSync(output,{recursive:true,force:true});}
});
