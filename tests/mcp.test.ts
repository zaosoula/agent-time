import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {EventStore} from '../src/capture/store.ts';
import {makeEvent} from '../src/capture/events.ts';
import {coverage,coverageForRange,currentWork,explainAttribution,inferRecentSession,sessions,snapshot,timeForIssue,timeForProject,timeline,unattributed,verifyPort,writeReport} from '../src/mcp/data.ts';
import {validAgentReport} from '../src/mcp/report.ts';
import {importSpool} from '../src/capture/hooks.ts';

const fixture=()=>mkdtempSync(join(tmpdir(),'agent-time-mcp-'));
const today=()=>{const d=new Date();d.setHours(10,0,0,0);return d.getTime()/1000;};

test('MCP project context reconciles its standalone session without claiming a peer or adding reported time',()=>{
 const output=fixture(),store=new EventStore(join(output,'events.sqlite')),at=today();
 try{
  const context=makeEvent('agent_report','work_context',{provider:'claude',sessionId:'standalone-a',observedAt:at-1,data:{contextId:randomUUID(),project:'/tmp/standalone-project',issueKey:'EZYO-863',task:'Build'}});store.put(context);
  for(const sessionId of ['standalone-a','standalone-b']){
   put(store,'tool_start',at,{provider:'claude',hostId:'local',sessionId,data:{toolId:'one'}});
   put(store,'tool_end',at+45,{provider:'claude',hostId:'local',sessionId,data:{toolId:'one'}});
  }
  const start=makeEvent('agent_report','task_start',{provider:'claude',sessionId:'standalone-a',observedAt:at,data:{contextId:randomUUID(),name:'Build'}});
  store.put(start);store.put(makeEvent('agent_report','task_stop',{provider:'claude',sessionId:'standalone-a',observedAt:at+45,data:{contextId:start.data!.contextId,taskCounterId:start.eventId}}));
  const s=snapshot(output,at-2,at+60);assert.equal(s.summary.agentSeconds,120);
  assert.equal(timeForProject(s,'/tmp/standalone-project').agentRunningSeconds,60);
  assert.equal(timeForIssue(s,'EZYO-863').agentRunningSeconds,60);
  writeFileSync(join(output,'settings.json'),JSON.stringify({countTaskCounters:true}));
  assert.equal(snapshot(output,at-2,at+60).summary.agentSeconds,120,'opt-in task counters cannot duplicate a measured standalone span');
 }finally{store.close();rmSync(output,{recursive:true,force:true});}
});

test('MCP cumulative time scopes equal native session IDs by provider',()=>{
 const output=fixture(),store=new EventStore(join(output,'events.sqlite')),at=today();
 try{
  for(const provider of ['claude','codex']){
   put(store,'tool_start',at,{provider,hostId:'local',sessionId:'same',data:{toolId:'one'}});
   put(store,'tool_end',at+45,{provider,hostId:'local',sessionId:'same',data:{toolId:'one'}});
  }
  const s=snapshot(output,at-1,at+60);assert.equal(s.summary.agentSeconds,120);
  assert.equal(s.summary.agentWallSeconds,60);
 }finally{store.close();rmSync(output,{recursive:true,force:true});}
});
const put=(store:EventStore,kind:string,at:number,fields:Record<string,unknown>={})=>store.put(makeEvent('hook',kind,{observedAt:at,monotonicAt:at,...fields}));

test('agent declarations are idempotent, validated, and do not change measured totals',()=>{
 const output=fixture();try{
  const store=new EventStore(join(output,'events.sqlite')),at=Date.now()/1000-120,id=randomUUID(),contextId=randomUUID();
  const who={provider:'codex',sessionId:'session-a',workspaceId:'test::/tmp/project'};
  put(store,'prompt_submitted',at,{...who,hostId:'local',terminalHandle:'terminal-a'});
  put(store,'response_stop',at+60,{...who,hostId:'local',terminalHandle:'terminal-a'});
  const before=snapshot(output,at-1,at+180);
  const event=writeReport(output,'work_context',id,contextId,{issueKey:'EZYO-863',project:'/tmp/project',task:'Implement MCP'},who);
  assert.equal(writeReport(output,'work_context',id,contextId,{issueKey:'EZYO-863',project:'/tmp/project',task:'Implement MCP'},who).eventId,id);
  assert.throws(()=>writeReport(output,'work_context',id,contextId,{issueKey:'EZYO-1',project:'/tmp/project',task:'Other'},who),/different declaration/);
  assert.equal(validAgentReport(event),true);
  assert.equal(validAgentReport({...event,data:{...event.data,prompt:'secret'}}),false);
  assert.equal(importSpool(join(output,'spool'),store,validAgentReport).length,0);
  const after=snapshot(output,at-1,at+180);
  assert.equal(after.summary.agentSeconds,before.summary.agentSeconds);
  assert.equal(timeForIssue(after,'EZYO-863').agentRunningSeconds,0,'a declaration after a completed turn cannot retroactively claim it');
  store.close();
 }finally{rmSync(output,{recursive:true,force:true});}
});

test('reported issue context links only its own hook session; parallel agent wall time merges',()=>{
 const output=fixture();try{
  const store=new EventStore(join(output,'events.sqlite')),at=today();
  const contextId=randomUUID(),id=randomUUID();
  const who={provider:'codex',sessionId:'session-a',workspaceId:'test::/tmp/project'};
  const report=writeReport(output,'work_context',id,contextId,{issueKey:'EZYO-863',project:'/tmp/project',task:'MCP'},who);
  // The declaration is made before the measured turn and is imported by the collector.
  report.observedAt=at-1;report.monotonicAt=at-1;
  store.put(report);
  for(const [session,terminal] of [['session-a','terminal-a'],['session-b','terminal-b']] as const){
   put(store,'prompt_submitted',at,{provider:'codex',sessionId:session,workspaceId:who.workspaceId,hostId:'local',terminalHandle:terminal});
   put(store,'response_stop',at+60,{provider:'codex',sessionId:session,workspaceId:who.workspaceId,hostId:'local',terminalHandle:terminal});
  }
  const s=snapshot(output,at-2,at+120),issue=timeForIssue(s,'EZYO-863'),project=timeForProject(s,'/tmp/project');
  assert.equal(issue.agentRunningSeconds,60);
  assert.equal(project.agentRunningSeconds,120);
  assert.equal(project.overlapMergedWallSeconds,60);
  assert.equal(timeline(s).segments.filter(i=>i.state==='agent').length,1);
  assert.equal(timeline(s).segments[0]?.agentCount,2);
  assert.equal(explainAttribution(s,s.summary.intervals.find(i=>i.state==='grouped')!.sourceEventIds[0]!).found,true);
  assert.equal(coverage(s).issues.length,0);
  assert.equal(unattributed(s).groups.length,0);
  store.close();
 }finally{rmSync(output,{recursive:true,force:true});}
});

test('a pending task counter is visible but never counted as measured time',()=>{
 const output=fixture();try{
  const contextId=randomUUID(),id=randomUUID();
  writeReport(output,'task_start',id,contextId,{name:'Waiting on build'},{});
  const work=currentWork(output);
  assert.equal(work.tasks[0]?.taskCounterId,id);
  assert.equal(work.tasks[0]?.measured,false);
 }finally{rmSync(output,{recursive:true,force:true});}
});

test('nearby reported issue offers human review evidence without adding issue time',()=>{
 const output=fixture();try{
  const store=new EventStore(join(output,'events.sqlite')),at=today(),contextId=randomUUID(),id=randomUUID();
  const report=writeReport(output,'work_context',id,contextId,{issueKey:'EZYO-863',project:'/tmp/project',task:'Review'},{});
  report.observedAt=at-1;report.monotonicAt=at-1;store.put(report);
  for(const offset of [10,20])store.put(makeEvent('macos','activity',{observedAt:at+offset,monotonicAt:at+offset,workspaceId:'test::/tmp/project',data:{foregroundBundleId:'com.stablyai.orca',idleSeconds:0,tabId:'tab-a'}}));
  const issue=timeForIssue(snapshot(output,at-2,at+60),'EZYO-863');
  assert.equal(issue.humanActiveSeconds,0);
  assert.ok(issue.suggestedHumanSeconds>0);
  assert.ok(issue.suggestedHumanIntervals.length>0);
  store.close();
 }finally{rmSync(output,{recursive:true,force:true});}
});

test('automatic hook session binding refuses ambiguous concurrent sessions',()=>{
 const output=fixture();try{
  const store=new EventStore(join(output,'events.sqlite')),at=Date.now()/1000;
  put(store,'prompt_submitted',at-3,{provider:'codex',sessionId:'a',workspaceId:'ws-a'});
  assert.equal(inferRecentSession(output,'codex','ws-a'),'a');
  put(store,'prompt_submitted',at-2,{provider:'codex',sessionId:'b',workspaceId:'ws-a'});
  assert.equal(inferRecentSession(output,'codex','ws-a'),null);
  assert.equal(inferRecentSession(output,'codex','ws-b'),null);
  put(store,'session_end',at-1,{provider:'codex',sessionId:'b',workspaceId:'ws-a'});
  assert.equal(inferRecentSession(output,'codex','ws-a'),'a');
  store.close();
 }finally{rmSync(output,{recursive:true,force:true});}
});

test('coverage reports historical Accessibility loss separately from missing capture',()=>{
 const output=fixture();try{
  const store=new EventStore(join(output,'events.sqlite')),at=today();
  for(const [offset,trusted] of [[0,false],[10,false],[20,true],[30,false]] as const)store.put(makeEvent('macos','activity',{observedAt:at+offset,monotonicAt:at+offset,data:{accessibilityTrusted:trusted,idleSeconds:0,foregroundBundleId:'example.app'}}));
  const result=coverage(snapshot(output,at-1,at+60));
  assert.equal(result.permissionPeriods.length,2);
  assert.equal(result.permissionPeriods[0]?.end,at+10);
  assert.equal(result.permissionPeriods[1]?.start,at+30);
  const streamed=coverageForRange(output,at-1,at+60);
  assert.equal(streamed.permissionPeriods.length,2);
  assert.equal(streamed.observationGaps.length,0);
  store.close();
 }finally{rmSync(output,{recursive:true,force:true});}
});

test('port claims can be checked against a real local TCP listener',async()=>{
 const listener=createServer();
 await new Promise<void>(resolve=>listener.listen(0,'127.0.0.1',resolve));
 const address=listener.address();assert.ok(address&&typeof address==='object');
 const open=verifyPort(address.port);assert.equal(open.verified,true);assert.equal(open.processId,process.pid);
 await new Promise<void>(resolve=>listener.close(()=>resolve()));
 const closed=verifyPort(address.port);assert.equal(closed.verified,true);assert.equal(closed.processId,null);
});

test('MCP timeline and review queue omit page URLs and titles',()=>{
 const output=fixture();try{
  const store=new EventStore(join(output,'events.sqlite')),at=today();
  for(const offset of [0,10])store.put(makeEvent('macos','activity',{observedAt:at+offset,monotonicAt:at+offset,data:{foregroundBundleId:'com.apple.Safari',idleSeconds:0,browserDomain:'example.com',browserUrl:'https://example.com/?token=secret',browserTitle:'Private document'}}));
  const s=snapshot(output,at-1,at+20);
  assert.equal(unattributed(s).groups[0]?.label,'example.com');
  assert.equal(JSON.stringify(timeline(s)).includes('token=secret'),false);
  assert.equal(JSON.stringify(timeline(s)).includes('Private document'),false);
  store.close();
 }finally{rmSync(output,{recursive:true,force:true});}
});

test('new context is queryable before the collector imports its spool event',()=>{
 const output=fixture();try{
  const store=new EventStore(join(output,'events.sqlite')),at=Date.now()/1000+2;
  const who={provider:'codex',sessionId:'pending-session',workspaceId:'test::/tmp/project'};
  writeReport(output,'work_context',randomUUID(),randomUUID(),{issueKey:'EZYO-863',project:'/tmp/project',task:'Just started'},who);
  put(store,'prompt_submitted',at,{...who,hostId:'local',terminalHandle:'pending-terminal'});
  put(store,'response_stop',at+60,{...who,hostId:'local',terminalHandle:'pending-terminal'});
  assert.equal(timeForIssue(snapshot(output,at-3,at+90),'EZYO-863').agentRunningSeconds,60);
  store.close();
 }finally{rmSync(output,{recursive:true,force:true});}
});

test('Orca worktree keys link measured time while Linear page keys stay suggestions',()=>{
 const output=fixture();try{
  const store=new EventStore(join(output,'events.sqlite')),at=today(),workspaceId='test::/tmp/kuva/.orca/workspaces/ezyo-655-backoffice';
  const who={provider:'claude',sessionId:'historic',workspaceId,hostId:'local',terminalHandle:'term'};
  put(store,'prompt_submitted',at,who);put(store,'response_stop',at+60,who);
  for(const offset of [70,80])store.put(makeEvent('macos','activity',{observedAt:at+offset,monotonicAt:at+offset,data:{foregroundBundleId:'com.brave.Browser',idleSeconds:0,browserDomain:'linear.app',browserUrl:'https://linear.app/ezyostudio/issue/EZYO-666/example',browserTitle:'EZYO-666'}}));
  const s=snapshot(output,at-1,at+100);
  assert.equal(timeForIssue(s,'EZYO-655').agentRunningSeconds,60);
  assert.equal(timeForProject(s,'/tmp/kuva').agentRunningSeconds,60);
  assert.equal(timeForProject(s,workspaceId).agentRunningSeconds,60);
  assert.equal(sessions(s,{issueKey:'EZYO-655'}).sessions.length,1);
  assert.equal(timeForIssue(s,'EZYO-666').humanActiveSeconds,0);
  assert.ok(timeForIssue(s,'EZYO-666').suggestedHumanSeconds>0);
  assert.equal(unattributed(s).groups[0]?.suggestedIssueKey,'EZYO-666');
  store.close();
 }finally{rmSync(output,{recursive:true,force:true});}
});

test('timeline merges overlapping human and agent activity into a both segment',()=>{
 const output=fixture();try{
  const store=new EventStore(join(output,'events.sqlite')),at=today(),who={provider:'codex',sessionId:'s',workspaceId:'test::/tmp/project',hostId:'local',terminalHandle:'t'};
  put(store,'prompt_submitted',at,who);put(store,'response_stop',at+60,who);
  for(const offset of [10,20])store.put(makeEvent('macos','activity',{observedAt:at+offset,monotonicAt:at+offset,workspaceId:who.workspaceId,data:{foregroundBundleId:'com.stablyai.orca',idleSeconds:0,tabId:'tab-a'}}));
  const result=timeline(snapshot(output,at-1,at+70));
  assert.ok(result.segments.some(segment=>segment.state==='both'));
  assert.equal(result.totals.agentRunningSeconds,60);
  assert.equal(result.totals.overlapMergedWallSeconds,60);
  store.close();
 }finally{rmSync(output,{recursive:true,force:true});}
});

test('explicit free ticket references and task metadata pass the spool without relaxing automatic page extraction',()=>{
 const output=fixture();try{
  const contextId=randomUUID();
  for(const issueKey of ['T-9716','D-140','K-189','Client facture 2026/11']){
   const event=writeReport(output,'work_context',randomUUID(),contextId,{issueKey,project:'KANZen',agentIdentity:{id:'cto',name:'CTO'},billable:false});assert.equal(validAgentReport(event),true);
  }
  const event=writeReport(output,'task_start',randomUUID(),contextId,{name:'TVA',issueKey:'T-9716',project:'KANZen',parentTaskCounterId:randomUUID(),leaseSeconds:900});
  assert.equal(validAgentReport(event),true);
  assert.equal(validAgentReport({...event,data:{...event.data,issueKey:'bad\nreference'}}),false);
  assert.equal(validAgentReport({...event,data:{...event.data,leaseSeconds:Infinity}}),false);
  const stop=writeReport(output,'task_stop',randomUUID(),contextId,{taskCounterId:event.eventId,usage:{inputTokens:120,outputTokens:20,cost:0.03,currency:'USD',source:'provider-response'},outcome:'failed'});
  assert.equal(validAgentReport(stop),true);
  assert.equal(validAgentReport({...stop,data:{...stop.data,usage:{cost:-1,currency:'USD',source:'provider-response'}}}),false);
 }finally{rmSync(output,{recursive:true,force:true});}
});

test('task context snapshots survive retries and children; stops keep native identity and cannot close twice',async()=>{
 const {writeTaskReport,taskHistory}=await import('../src/mcp/data.ts');
 const output=fixture();try{
  const contextId=randomUUID(),who={provider:'claude',sessionId:'native-cto',workspaceId:'/bureau'};
  writeReport(output,'work_context',randomUUID(),contextId,{project:'KANZen',issueKey:'T-9716',agentIdentity:{id:'cto',name:'CTO'},billable:false},who);
  const id=randomUUID(),start=writeTaskReport(output,'task_start',id,contextId,{name:'TVA'},who);
  assert.equal(start.data?.project,'KANZen');assert.equal(start.data?.billable,false);assert.equal(start.data?.leaseSeconds,900);
  writeReport(output,'work_context',randomUUID(),contextId,{project:'Interne',issueKey:'D-140'},who);
  assert.deepEqual(writeTaskReport(output,'task_start',id,contextId,{name:'TVA'},who),start);
  const child=writeTaskReport(output,'task_start',randomUUID(),randomUUID(),{name:'Verify',parentTaskCounterId:id,agentIdentity:{id:'cfo'}},{provider:'claude',sessionId:'native-cfo'});
  assert.equal(child.data?.project,'KANZen');assert.equal((child.data?.agentIdentity as {id:string}).id,'cfo');
  assert.throws(()=>writeTaskReport(output,'task_start',randomUUID(),contextId,{name:'Bad',parentTaskCounterId:randomUUID()},who),/Unknown parent/);
  assert.throws(()=>writeTaskReport(output,'task_stop',randomUUID(),contextId,{taskCounterId:id},{sessionId:'another-native'}),/different native/);
  const stopId=randomUUID(),stop=writeTaskReport(output,'task_stop',stopId,contextId,{taskCounterId:id,outcome:'failed',usage:{cost:0.02,currency:'USD',source:'agent-reported'}});
  assert.equal(stop.sessionId,'native-cto');assert.equal(writeTaskReport(output,'task_stop',stopId,contextId,{taskCounterId:id,outcome:'failed',usage:{cost:0.02,currency:'USD',source:'agent-reported'}}).eventId,stopId);
  assert.throws(()=>writeTaskReport(output,'task_stop',randomUUID(),contextId,{taskCounterId:id}),/already closed/);
  const history=taskHistory(output,start.observedAt-1,Date.now()/1000+1,{issueKey:'T-9716'});
  assert.equal(history.tasks.length,2);assert.equal(history.tasks.find(t=>t.id===id)?.status,'failed');assert.equal(history.tasks.find(t=>t.id===id)?.usageVerified,false);
 }finally{rmSync(output,{recursive:true,force:true});}
});

test('leased counters renew, expire durably across server connections and can be finalized after a crash',async()=>{
 const {writeTaskReport}=await import('../src/mcp/data.ts');const output=fixture();const store=new EventStore(join(output,'events.sqlite'));
 try{
  const at=Date.now()/1000,id=randomUUID(),contextId=randomUUID();
  store.put(makeEvent('agent_report','task_start',{eventId:id,observedAt:at-2000,data:{requestId:id,contextId,name:'Crash',leaseSeconds:900}}));
  const item=currentWork(output).tasks.find(t=>t.id===id);assert.equal(item?.status,'interrupted');assert.equal(item?.reportedElapsedSeconds,0);
  assert.throws(()=>writeTaskReport(output,'task_heartbeat',randomUUID(),contextId,{taskCounterId:id}),/expired/);
  writeTaskReport(output,'task_stop',randomUUID(),contextId,{taskCounterId:id,outcome:'cancelled'});
  assert.equal(currentWork(output).tasks.some(t=>t.id===id),false);
  const live=writeTaskReport(output,'task_start',randomUUID(),contextId,{name:'Alive'});
  const heartbeat=writeTaskReport(output,'task_heartbeat',randomUUID(),contextId,{taskCounterId:live.eventId});assert.equal(validAgentReport(heartbeat),true);
 }finally{store.close();rmSync(output,{recursive:true,force:true});}
});

test('opt-in declared task gaps appear in MCP totals under their snapshotted project and free ticket',()=>{
 const output=fixture(),store=new EventStore(join(output,'events.sqlite')),at=today();try{
  const contextId=randomUUID(),id=randomUUID();
  store.put(makeEvent('agent_report','task_start',{eventId:id,provider:'claude',sessionId:'s',workspaceId:'/bureau',observedAt:at,data:{contextId,name:'TVA',issueKey:'T-9716',project:'KANZen'}}));
  store.put(makeEvent('agent_report','task_stop',{observedAt:at+60,data:{contextId,taskCounterId:id}}));
  assert.equal(snapshot(output,at-1,at+120).summary.agentSeconds,0);
  writeFileSync(join(output,'settings.json'),JSON.stringify({countTaskCounters:true}));
  const s=snapshot(output,at-1,at+120);assert.equal(s.summary.agentSeconds,60);
  assert.equal(timeForProject(s,'KANZen').agentRunningSeconds,60);assert.equal(timeForIssue(s,'T-9716').agentRunningSeconds,60);
 }finally{store.close();rmSync(output,{recursive:true,force:true});}
});

test('renewed counters older than 12 hours remain visible and keep their project metadata',async()=>{
 const {taskHistory}=await import('../src/mcp/data.ts');const output=fixture(),store=new EventStore(join(output,'events.sqlite'));try{
  const at=Date.now()/1000,id=randomUUID(),contextId=randomUUID();
  store.put(makeEvent('agent_report','task_start',{eventId:id,observedAt:at-13*3600,data:{contextId,name:'Long task',project:'KANZen',issueKey:'K-189',leaseSeconds:43200}}));
  store.put(makeEvent('agent_report','task_heartbeat',{observedAt:at-3600,data:{contextId,taskCounterId:id}}));
  assert.equal(currentWork(output).tasks.find(t=>t.id===id)?.active,true);
  assert.equal(taskHistory(output,at-1800,at+1).tasks.find(t=>t.id===id)?.project,'KANZen');
  assert.equal(store.taskReportEvidence(at-7200,at+1).some(e=>e.eventId===id),true);
 }finally{store.close();rmSync(output,{recursive:true,force:true});}
});

test('opt-in counters started before the context lookback retain snapshot attribution',()=>{
 const output=fixture(),store=new EventStore(join(output,'events.sqlite')),at=today();try{
  const id=randomUUID(),contextId=randomUUID();
  store.put(makeEvent('agent_report','task_start',{eventId:id,provider:'claude',sessionId:'s',workspaceId:'/bureau',observedAt:at-7200,data:{contextId,name:'TVA',project:'KANZen',issueKey:'T-9716'}}));
  store.put(makeEvent('agent_report','task_stop',{observedAt:at+60,data:{contextId,taskCounterId:id}}));
  writeFileSync(join(output,'settings.json'),JSON.stringify({countTaskCounters:true}));
  const s=snapshot(output,at,at+120);assert.equal(timeForProject(s,'KANZen').agentRunningSeconds,60);assert.equal(timeForIssue(s,'T-9716').agentRunningSeconds,60);
 }finally{store.close();rmSync(output,{recursive:true,force:true});}
});

test('task queries use report indexes and never decode unrelated packed capture blocks',async()=>{
 const {taskHistory}=await import('../src/mcp/data.ts');const {packEventHistory}=await import('../src/capture/packed-maintenance.ts');
 const output=fixture(),store=new EventStore(join(output,'events.sqlite')),at=Date.now()/1000;try{
  store.put(makeEvent('macos','activity',{observedAt:at-86400,data:{foregroundName:'Private app'}}));
  packEventHistory(store.database,{now:at+86400,hotDays:0});
  assert.ok(Number(store.database.prepare('SELECT count(*) n FROM at_event_blocks').get()?.n)>0);
  const id=randomUUID(),contextId=randomUUID();store.put(makeEvent('agent_report','task_start',{eventId:id,observedAt:at-60,data:{contextId,name:'Task',project:'KANZen'}}));
  // An unrelated corrupt activity block makes accidental capture replay observable.
  store.database.exec("UPDATE at_event_blocks SET data=x'0102'");
  assert.equal(taskHistory(output,at-2*86400,at+1).tasks[0]?.id,id);
  assert.equal(currentWork(output).tasks[0]?.id,id);
 }finally{store.close();rmSync(output,{recursive:true,force:true});}
});
