import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {EventStore} from '../src/capture/store.ts';
import {makeEvent} from '../src/capture/events.ts';
import {snapshot,attributedIntervals} from '../src/mcp/data.ts';
import {BillingStore} from '../src/capture/billing-store.ts';
import {billingForProject,validateBillingRequest} from '../src/capture/billing-service.ts';
import {BillingReports} from '../src/capture/billing-worker.ts';
import type {BillingProgress} from '../src/capture/billing-progress.ts';
import {packEventHistory} from '../src/capture/packed-maintenance.ts';

test('billing omits out-of-lifetime metadata searches without changing attributed time in packed history',()=>{
 const output=mkdtempSync(join(tmpdir(),'at-billing-performance-')),store=new EventStore(join(output,'events.sqlite'));
 try{
  const start=Date.parse('2026-11-10T00:00:00Z')/1000;
  store.put(makeEvent('hook','session_start',{provider:'claude',hostId:'one',sessionId:'long',cwd:'/project',observedAt:start-3*86400,data:{agentIdentity:{id:'launcher'},attributes:{team:'one'}}}));
  store.put(makeEvent('agent_report','work_context',{provider:'claude',hostId:'one',sessionId:'long',observedAt:start-3*86400,data:{project:'Expired',issueKey:'OLD-1'}}));
  store.put(makeEvent('agent_report','work_context',{provider:'claude',hostId:'one',sessionId:'long',observedAt:start-100,data:{project:'/project',issueKey:'T-1'}}));
  for(const hostId of ['one','two'])for(const [kind,offset] of [['tool_start',-50],['tool_end',100]] as const)store.put(makeEvent('hook',kind,{provider:'claude',hostId,sessionId:'long',cwd:'/project',observedAt:start+offset,data:{toolId:'t'}}));
  for(const offset of [-1,5,10])store.put(makeEvent('macos','activity',{observedAt:start+offset,data:{foregroundBundleId:'fixture',idleSeconds:0,accessibilityTrusted:true}}));
  store.put(makeEvent('capture','capture_stop',{observedAt:start+80}));
  while(packEventHistory(store.database,{now:start+10*86400}).packedEvents){}
  const reference=snapshot(output,start,start+86400,{database:store.database,persistedOnly:true,countTaskCounters:false});
  const prepare=store.database.prepare.bind(store.database);let oldAnchorQueries=0;
  store.database.prepare=((sql:string)=>{if(sql.includes('observed_at<?')&&sql.includes("json_extract(payload,'$.source')='hook'"))oldAnchorQueries++;return prepare(sql);}) as typeof store.database.prepare;
  const fast=snapshot(output,start,start+86400,{database:store.database,persistedOnly:true,countTaskCounters:false,billingEvidence:true});
  assert.equal(oldAnchorQueries,0);
  assert.deepEqual(fast.summary,reference.summary);
  assert.deepEqual(attributedIntervals(fast),attributedIntervals(reference));
  assert(fast.events.some(e=>e.kind==='capture_stop'));
 }finally{store.close();rmSync(output,{recursive:true,force:true});}
});

test('worker progress tracks real completed days and stays queryable without retaining reports',async()=>{
 const output=mkdtempSync(join(tmpdir(),'at-billing-progress-')),store=new EventStore(join(output,'events.sqlite'));
 try{
  new BillingStore(store.database).saveProject({id:'fixture',name:'Fixture',aliases:[],sources:{repositories:['/project'],workspaceIds:[],reportedProjects:[]},timezone:'UTC',policies:[{id:'one',effectiveFrom:'2026-01-01',basis:'overlapMergedWall',countingMode:'minutes',currency:'EUR',hourlyRate:'75',agentOnlyHourlyRate:null,agentWeight:'1',rounding:{minutes:1,mode:'nearest',scope:'period'},dailyCapMinutes:null,presenceWindowMinutes:null,aiFees:{mode:'none'}}]});
  const request={project:'fixture',fromDate:'2026-11-09',toDate:'2026-11-10'};
  const events:BillingProgress[]=[];const reference=billingForProject(output,request,p=>events.push(p));
  assert.deepEqual(events.map(p=>[p.phase,p.completedDays,p.totalDays]),[['reading',0,2],['calculating',1,2],['reading',1,2],['calculating',2,2],['saving',2,2]]);
  const jobs=new BillingReports(output),id='12345678-1234-1234-1234-123456789abc';
  const pending=jobs.run({...request,progressId:id});
  assert.equal(jobs.progress(id)?.phase,'reading');
  await assert.rejects(jobs.run(request),/already running/);
  const result=await pending;assert.deepEqual(result,reference);assert.deepEqual(jobs.progress(id),{phase:'complete',completedDays:2,totalDays:2});
  await assert.rejects(jobs.run({...request,progressId:id}),/already used/);
  const failedId='12345678-1234-1234-1234-123456789abd';await assert.rejects(jobs.run({...request,project:'missing',progressId:failedId}),/Unknown/);assert.equal(jobs.progress(failedId)?.phase,'failed');
  assert.equal(jobs.progress('not-found'),null);
  assert.throws(()=>validateBillingRequest({...request,progressId:'../../file'}),/progress/);
 }finally{store.close();rmSync(output,{recursive:true,force:true});}
});

test('old work context still qualifies a recent projectless prompt for presence-gated billing',()=>{
 const output=mkdtempSync(join(tmpdir(),'at-billing-presence-')),store=new EventStore(join(output,'events.sqlite'));
 try{
  new BillingStore(store.database).saveProject({id:'presence',name:'Presence',aliases:[],sources:{repositories:['/project'],workspaceIds:[],reportedProjects:['Project']},timezone:'UTC',policies:[{id:'one',effectiveFrom:'2026-01-01',basis:'overlapMergedWall',countingMode:'seconds',currency:'EUR',hourlyRate:'75',agentOnlyHourlyRate:null,agentWeight:'1',rounding:{minutes:1,mode:'nearest',scope:'period'},dailyCapMinutes:null,presenceWindowMinutes:15,aiFees:{mode:'none'}}]});
  const start=Date.parse('2026-11-10T00:00:00Z')/1000;
  store.put(makeEvent('agent_report','work_context',{provider:'claude',sessionId:'long',observedAt:start-3*86400,data:{project:'Project'}}));
  store.put(makeEvent('hook','prompt_submitted',{provider:'claude',hostId:'h',sessionId:'long',observedAt:start+10,data:{humanInitiated:true}}));
  for(const [kind,offset] of [['tool_start',20],['tool_end',100]] as const)store.put(makeEvent('hook',kind,{provider:'claude',hostId:'h',sessionId:'long',cwd:'/project',observedAt:start+offset,data:{toolId:'t'}}));
  const report=billingForProject(output,{project:'presence',fromDate:'2026-11-10',toDate:'2026-11-10'}).report;
  assert.equal(report.totals.eligibleSeconds,80);
 }finally{store.close();rmSync(output,{recursive:true,force:true});}
});

test('batched context hydration preserves equal-timestamp host order and explicit empty host matching',()=>{
 const output=mkdtempSync(join(tmpdir(),'at-billing-context-order-')),store=new EventStore(join(output,'events.sqlite'));
 try{
  const start=Date.parse('2026-11-10T00:00:00Z')/1000;
  for(const hostId of ['A','B',''])store.put(makeEvent('agent_report','work_context',{provider:'claude',hostId,sessionId:'same',observedAt:start-3*86400,data:{project:hostId||'empty'}}));
  for(const hostId of ['A','B'])for(const [kind,offset] of [['tool_start',20],['tool_end',100]] as const)store.put(makeEvent('hook',kind,{provider:'claude',hostId,sessionId:'same',cwd:'/project',observedAt:start+offset,data:{toolId:'t'}}));
  const options={database:store.database,persistedOnly:true,countTaskCounters:false};
  const reference=snapshot(output,start,start+86400,options),fast=snapshot(output,start,start+86400,{...options,billingEvidence:true});
  assert.deepEqual(fast.events.filter(e=>e.kind==='work_context'),reference.events.filter(e=>e.kind==='work_context'));
  assert.deepEqual(fast.events.filter(e=>e.kind==='work_context').map(e=>e.hostId),['A','B']);
 }finally{store.close();rmSync(output,{recursive:true,force:true});}
});
