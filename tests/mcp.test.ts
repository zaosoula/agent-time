import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {EventStore} from '../src/capture/store.ts';
import {makeEvent} from '../src/capture/events.ts';
import {coverage,coverageForRange,currentWork,explainAttribution,inferRecentSession,snapshot,timeForIssue,timeForProject,timeline,unattributed,verifyPort,writeReport} from '../src/mcp/data.ts';
import {validAgentReport} from '../src/mcp/report.ts';
import {importSpool} from '../src/capture/hooks.ts';

const fixture=()=>mkdtempSync(join(tmpdir(),'agent-time-mcp-'));
const today=()=>{const d=new Date();d.setHours(10,0,0,0);return d.getTime()/1000;};
const put=(store:EventStore,kind:string,at:number,fields:Record<string,unknown>={})=>store.put(makeEvent('hook',kind,{observedAt:at,monotonicAt:at,...fields}));

test('agent declarations are idempotent, validated, and do not change measured totals',()=>{
 const output=fixture();try{
  const store=new EventStore(join(output,'events.sqlite')),at=today(),id=randomUUID(),contextId=randomUUID();
  const who={provider:'codex',sessionId:'session-a',workspaceId:'test::/tmp/project'};
  put(store,'prompt_submitted',at,{...who,hostId:'local',terminalHandle:'terminal-a'});
  put(store,'response_stop',at+60,{...who,hostId:'local',terminalHandle:'terminal-a'});
  const before=snapshot(output,at-1,at+120);
  const event=writeReport(output,'work_context',id,contextId,{issueKey:'EZYO-863',project:'/tmp/project',task:'Implement MCP'},who);
  assert.equal(writeReport(output,'work_context',id,contextId,{issueKey:'EZYO-863',project:'/tmp/project',task:'Implement MCP'},who).eventId,id);
  assert.throws(()=>writeReport(output,'work_context',id,contextId,{issueKey:'EZYO-1',project:'/tmp/project',task:'Other'},who),/different declaration/);
  assert.equal(validAgentReport(event),true);
  assert.equal(validAgentReport({...event,data:{...event.data,prompt:'secret'}}),false);
  assert.equal(importSpool(join(output,'spool'),store,validAgentReport).length,0);
  const after=snapshot(output,at-1,at+120);
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
  assert.equal(timeline(s).intervals.filter(i=>i.state==='grouped').length,2);
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
