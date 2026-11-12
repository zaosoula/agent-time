import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {EventStore} from '../src/capture/store.ts';import {makeEvent} from '../src/capture/events.ts';
import {BillingStore} from '../src/capture/billing-store.ts';import {billingForProject,billingProjects} from '../src/capture/billing-service.ts';
import {billingDayStart} from '../src/capture/billing-calendar.ts';import type {BillingProject} from '../src/capture/billing-types.ts';
const project:BillingProject={id:'caex',name:'CAEX',aliases:['client-caex'],sources:{repositories:['/fixture/caex','/fixture/infra'],workspaceIds:[],reportedProjects:['CAEX']},timezone:'Europe/Paris',policies:[{id:'v1',effectiveFrom:'2026-01-01',basis:'overlapMergedWall',currency:'EUR',hourlyRate:'100.00',agentOnlyHourlyRate:null,agentWeight:'1',rounding:{minutes:1,mode:'nearest',scope:'period'},dailyCapMinutes:null,presenceWindowMinutes:null,aiFees:{mode:'none'}}]};
const fixture=()=>{const output=mkdtempSync(join(tmpdir(),'at-billing-service-')),store=new EventStore(join(output,'events.sqlite'));new BillingStore(store.database).saveProject(project);return {output,store};};
test('billing calendar follows the project timezone and daylight saving',()=>{assert.equal(billingDayStart('2026-03-30','Europe/Paris')-billingDayStart('2026-03-29','Europe/Paris'),23*3600);assert.equal(billingDayStart('2026-10-26','Europe/Paris')-billingDayStart('2026-10-25','Europe/Paris'),25*3600);assert.throws(()=>billingDayStart('2026-02-30','Europe/Paris'));});
test('database project grouping bills raw seconds once and saves a reproducible export',()=>{const {output,store}=fixture();try{
 const at=billingDayStart('2026-11-10','Europe/Paris')+36000;
 for(const [sessionId,cwd] of [['one','/fixture/caex'],['two','/fixture/infra']] as const){store.put(makeEvent('hook','tool_start',{provider:'claude',hostId:'local',sessionId,cwd,observedAt:at,data:{toolId:'tool'}}));store.put(makeEvent('hook','tool_end',{provider:'claude',hostId:'local',sessionId,cwd,observedAt:at+10,data:{toolId:'tool'}}));}
 const result=billingForProject(output,{project:'client-caex',fromDate:'2026-11-10',toDate:'2026-11-10',detail:'daily'});
 assert.equal(result.report.totals.overlapMergedWallSeconds,10);assert.equal(result.report.totals.agentRunningSeconds,20);assert.equal(result.report.totals.billableSeconds,0);
 const csv=billingForProject(output,{project:'caex',fromDate:'2026-11-10',toDate:'2026-11-10',reportId:result.report.reportId,format:'csv'});assert.ok(readFileSync(csv.export!.path,'utf8').includes('CAEX'));
 assert.equal(billingProjects(output).projects[0]?.id,'caex');assert.throws(()=>billingForProject(output,{project:'unknown',fromDate:'2026-11-10',toDate:'2026-11-10'}),/unknown|not found/i);
}finally{store.close();rmSync(output,{recursive:true,force:true});}});
test('a 31-day month is accepted, responses paginate and declared timers do not become billable',()=>{const {output,store}=fixture();try{
 const at=billingDayStart('2026-10-10','Europe/Paris');const task=makeEvent('agent_report','task_start',{observedAt:at,data:{name:'Declared',project:'CAEX'}});store.put(task);store.put(makeEvent('agent_report','task_stop',{observedAt:at+3600,data:{taskCounterId:task.eventId}}));
 const result=billingForProject(output,{project:'caex',fromDate:'2026-10-01',toDate:'2026-10-31',detail:'daily'});assert.equal(result.report.totals.overlapMergedWallSeconds,0);assert.equal(result.report.days.length,31);assert.equal(result.nextCursor,null);
}finally{store.close();rmSync(output,{recursive:true,force:true});}});

test('report worker persists immutable results without occupying the capture request loop',async()=>{
 const {runBillingReport}=await import('../src/capture/billing-worker.ts');const {output,store}=fixture();try{
 const result=await runBillingReport(output,{project:'caex',fromDate:'2026-11-01',toDate:'2026-11-02',detail:'daily'});
 assert.equal(result.report.days.length,2);assert.ok(result.report.inputRevision);assert.ok(new BillingStore(store.database).report(result.report.reportId));
 }finally{store.close();rmSync(output,{recursive:true,force:true});}
});

test('captured repository and reported project name in one billing group do not create a false conflict',()=>{
 const {output,store}=fixture();try{
 const at=billingDayStart('2026-11-10','Europe/Paris')+36000;
 store.put(makeEvent('agent_report','work_context',{provider:'claude',sessionId:'same',observedAt:at-1,data:{project:'CAEX'}}));
 store.put(makeEvent('hook','tool_start',{provider:'claude',hostId:'local',sessionId:'same',cwd:'/fixture/caex',observedAt:at,data:{toolId:'t'}}));
 store.put(makeEvent('hook','tool_end',{provider:'claude',hostId:'local',sessionId:'same',cwd:'/fixture/caex',observedAt:at+300,data:{toolId:'t'}}));
 const result=billingForProject(output,{project:'caex',fromDate:'2026-11-10',toDate:'2026-11-10'});assert.equal(result.report.totals.overlapMergedWallSeconds,300);
 }finally{store.close();rmSync(output,{recursive:true,force:true});}
});

test('measured project details preserve top-level issue and coverage fields',async()=>{
 const {projectTimeForRange}=await import('../src/capture/billing-service.ts');const {output,store}=fixture();try{
 const result=projectTimeForRange(output,{project:'caex',fromDate:'2026-11-10',toDate:'2026-11-10',view:'details'});assert.ok(Array.isArray(result.issues));assert.ok(result.captureCoverage);assert.ok(Array.isArray(result.captureCoverage?.issues));
 }finally{store.close();rmSync(output,{recursive:true,force:true});}
});

test('billing uses persisted SQLite context only, independent of unimported pending spool',async()=>{
 const {writeReport}=await import('../src/mcp/data.ts');const {randomUUID}=await import('node:crypto');const {output,store}=fixture();try{
 const at=Date.now()/1000-300,date=(await import('../src/capture/billing-calendar.ts')).billingLocalDate(at,'Europe/Paris');
 store.put(makeEvent('hook','tool_start',{provider:'claude',hostId:'local',sessionId:'one',cwd:'/fixture/caex',observedAt:at,data:{toolId:'t'}}));store.put(makeEvent('hook','tool_end',{provider:'claude',hostId:'local',sessionId:'one',cwd:'/fixture/caex',observedAt:at+200,data:{toolId:'t'}}));
 const first=billingForProject(output,{project:'caex',fromDate:date,toDate:date});
 writeReport(output,'work_context',randomUUID(),randomUUID(),{project:'OTHER'},{provider:'claude',sessionId:'one'});
 const second=billingForProject(output,{project:'caex',fromDate:date,toDate:date});assert.equal(second.report.totals.overlapMergedWallSeconds,first.report.totals.overlapMergedWallSeconds);assert.equal(second.report.inputRevision,first.report.inputRevision);
 }finally{store.close();rmSync(output,{recursive:true,force:true});}
});

test('task fees resolve the repository from workspace-only identity',()=>{
 const {output,store}=fixture();try{
 const config=new BillingStore(store.database).resolveProject('caex');new BillingStore(store.database).saveProject({...config,policies:[...config.policies,{...config.policies[0]!,id:'actual',aiFees:{mode:'actual'}}]},config.revision);
 const at=billingDayStart('2026-11-10','Europe/Paris')+100;
 const task=makeEvent('agent_report','task_start',{observedAt:at,workspaceId:'test::/fixture/caex/.orca/workspaces/audit',data:{name:'Fee'}});store.put(task);store.put(makeEvent('agent_report','task_stop',{observedAt:at+20,data:{taskCounterId:task.eventId,usage:{cost:5,currency:'EUR',source:'provider-response'}}}));
 const result=billingForProject(output,{project:'caex',fromDate:'2026-11-10',toDate:'2026-11-10'});assert.equal(result.report.totals.aiKnownAmount,'5.00');assert.equal(result.report.totals.aiAmount,null);
 }finally{store.close();rmSync(output,{recursive:true,force:true});}
});

test('historical browser resource attribution does not expire relative to today',()=>{
 const {output,store}=fixture();try{
 const at=billingDayStart('2026-09-10','Europe/Paris')+36000;
 store.put(makeEvent('agent_report','resource',{observedAt:at-10,workspaceId:'/fixture/caex',data:{url:'https://fixture.example/artifact',project:'/fixture/caex'}}));
 for(const when of [at,at+10])store.put(makeEvent('macos','activity',{observedAt:when,data:{foregroundBundleId:'com.brave.Browser',idleSeconds:0,accessibilityTrusted:true,browserUrl:'https://fixture.example/artifact',browserDomain:'fixture.example'}}));
 const result=billingForProject(output,{project:'caex',fromDate:'2026-09-10',toDate:'2026-09-10'});assert.equal(result.report.totals.humanActiveSeconds,10);
 }finally{store.close();rmSync(output,{recursive:true,force:true});}
});

test('unobserved Mac gaps are excluded rather than billed from autonomous agent intervals',()=>{
 const {output,store}=fixture();try{
 const at=billingDayStart('2026-11-10','Europe/Paris')+36000;
 for(const observedAt of [at,at+600])store.put(makeEvent('macos','activity',{observedAt,data:{idleSeconds:1000,accessibilityTrusted:true,foregroundBundleId:'fixture'}}));
 store.put(makeEvent('hook','tool_start',{provider:'claude',hostId:'local',sessionId:'gap',cwd:'/fixture/caex',observedAt:at+1,data:{toolId:'t'}}));store.put(makeEvent('hook','tool_end',{provider:'claude',hostId:'local',sessionId:'gap',cwd:'/fixture/caex',observedAt:at+599,data:{toolId:'t'}}));
 const result=billingForProject(output,{project:'caex',fromDate:'2026-11-10',toDate:'2026-11-10'});assert.equal(result.report.totals.billableSeconds,0);assert.equal(result.report.totals.excludedSeconds,600);assert.equal(result.report.quality.complete,false);
 }finally{store.close();rmSync(output,{recursive:true,force:true});}
});

test('long-range measured totals preserve pre-billing minute credit across midnight',async()=>{
 const {projectTimeForRange}=await import('../src/capture/billing-service.ts');const {snapshot,timeForProject}=await import('../src/mcp/data.ts');const {output,store}=fixture();try{
 const midnight=billingDayStart('2026-11-10','Europe/Paris');
 store.put(makeEvent('agent_report','work_context',{observedAt:midnight-4*3600,provider:'claude',sessionId:'one',data:{project:'/fixture/caex',issueKey:'T-1'}}));
 for(const [kind,at] of [['tool_start',midnight-1],['tool_end',midnight+1]] as const)store.put(makeEvent('hook',kind,{observedAt:at,provider:'claude',hostId:'fixture',sessionId:'one',cwd:'/fixture/caex',data:{toolId:'t'}}));
 const before=timeForProject(snapshot(output,midnight-86400,midnight+86400),'/fixture/caex');
 const next=projectTimeForRange(output,{project:'caex',fromDate:'2026-11-09',toDate:'2026-11-10',view:'details'});
 assert.equal(before.agentRunningSeconds,60);assert.equal(next.agentRunningSeconds,before.agentRunningSeconds);assert.equal(next.agentWallSeconds,before.agentWallSeconds);assert.equal(next.overlapMergedWallSeconds,before.overlapMergedWallSeconds);
 assert.equal(next.issues?.[0]?.agentRunningSeconds,before.issues[0]?.agentRunningSeconds);assert.deepEqual(next.issues?.map(i=>i.issueKey),before.issues.map(i=>i.issueKey));
 }finally{store.close();rmSync(output,{recursive:true,force:true});}
});
