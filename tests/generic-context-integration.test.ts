import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {normalizeHook,hookContext} from '../src/capture/hooks.ts';
import {EventStore} from '../src/capture/store.ts';
import {makeEvent} from '../src/capture/events.ts';
import {snapshot,sessions,timeline} from '../src/mcp/data.ts';
import {projectTimeForRange} from '../src/capture/billing-service.ts';

test('launcher hooks, linked worktrees and temporal MCP filters share the original measured clock',()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'agent-time-context-integration-'))),repo=join(root,'principal'),worktree=join(root,'linked'),output=join(root,'data');
 const git=(...args:string[])=>execFileSync('/usr/bin/git',args,{stdio:'pipe'});
 git('init',repo);git('-C',repo,'-c','user.name=Fixture','-c','user.email=fixture@example.test','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','--allow-empty','-m','fixture');
 git('-C',repo,'worktree','add','-b','fixture-worker',worktree);
 const store=new EventStore(join(output,'events.sqlite'));
 const date=new Date();date.setDate(date.getDate()-1);date.setHours(10,0,0,0);const at=date.getTime()/1000,day=`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
 try{
  for(const id of ['a','b'])for(const [kind,offset] of [['PreToolUse',0],['PostToolUse',60]] as const){
   const event=normalizeHook('claude',{hook_event_name:kind,session_id:`native-${id}`,cwd:worktree,agent_type:'builder',tool_use_id:`tool-${id}`},hookContext({AGENT_TIME_AGENT_ID:`worker-${id}`,AGENT_TIME_ATTR_CLIENT_ID:'client-one',UNRELATED_SECRET:'must-never-be-captured'}));
   event.observedAt=at+offset;event.monotonicAt=at+offset;event.collectorEpoch='fixture';
   assert.equal(event.cwd,worktree);assert.equal(event.projectPath,repo);assert.equal(event.agentId,undefined);
   assert.ok(!JSON.stringify(event).includes('must-never-be-captured'));store.put(event);
  }
  store.put(makeEvent('agent_report','work_context',{provider:'claude',hostId:'local',sessionId:'native-a',observedAt:at+30,data:{attributes:{client_id:'client-two'}}}));
  const measured=snapshot(output,at-1,at+61),all=timeline(measured),filtered=timeline(measured,undefined,{agentIdentityId:'worker-a'});
  assert.equal(all.totals.agentRunningSeconds,120);assert.equal(filtered.totals.agentRunningSeconds,60);assert.equal(filtered.totals.humanActiveSeconds,0);
  assert.equal(timeline(measured,undefined,{agentProfile:'builder'}).totals.agentRunningSeconds,120);
  const worker=sessions(measured,{agentIdentityId:'worker-a'}).sessions[0];
  assert.equal(worker?.sessionId,'native-a');assert.equal(worker?.attributes?.client_id,'client-two');assert.equal(worker?.projectPath,repo);
  assert.equal(filtered.contextSlices.reduce((sum,row)=>sum+row.observedSeconds,0),60);
  const query={project:repo,fromDate:day,toDate:day,view:'details' as const};
  assert.equal(projectTimeForRange(output,query).agentRunningSeconds,120);
  assert.equal(projectTimeForRange(output,{...query,agentIdentityId:'worker-a'}).agentRunningSeconds,60);
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
