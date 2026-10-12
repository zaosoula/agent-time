import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWorkers } from '../src/capture/orca.ts';
import { normalizeHook, spoolHook, importSpool } from '../src/capture/hooks.ts';
import { EventStore } from '../src/capture/store.ts';
test('all worker pages are read and repeated cursors are coverage errors', async () => {
  const pages = [{ok:true,result:{workers:[{dispatchId:'d1'}],page:{hasMore:true,nextCursor:'p2'}}},{ok:true,result:{workers:[{dispatchId:'d2'}],page:{hasMore:false}}}];
  const calls: string[][]=[];
  const result=await readWorkers(async a=>{calls.push(a);return pages.shift();}, 'r1');
  assert.equal(result.workers.length,2);assert.ok(calls[1].includes('p2')); assert.equal(result.coverage.length,0);
  const repeated=await readWorkers(async()=>({ok:true,result:{workers:[],page:{hasMore:true,nextCursor:'same'}}}));
  assert.match(repeated.coverage[0].reason,/cursor/);
});
test('partial page failure preserves evidence and reports omission', async () => {
  let count=0;const result=await readWorkers(async()=>{if(count++)throw new Error('timeout');return {ok:true,result:{workers:[{dispatchId:'d1'}],page:{hasMore:true,nextCursor:'p2'},hostScope:{omittedHostIds:['remote']}}};});
  assert.equal(result.workers.length,1);assert.equal(result.coverage.length,2);
});
test('hooks keep explicit Orca identity and discard prompt, transcript and tool text', () => {
  const event=normalizeHook('claude',{hook_event_name:'PreToolUse',session_id:'s1',tool_use_id:'t1',prompt:'secret',transcript_path:'/secret',tool_input:{command:'secret'}}, {terminalHandle:'term-1',workspaceId:'ws',hostId:'local'});
  assert.equal(event.sessionId,'s1');assert.equal(event.terminalHandle,'term-1'); assert.equal(event.kind,'tool_start');
  assert.ok(!JSON.stringify(event).includes('secret'));
});
test('native child IDs remain separate from shared root sessions', () => {
  const event=normalizeHook('claude',{hook_event_name:'SubagentStart',session_id:'root',agent_id:'child'},{});
  assert.equal(event.sessionId,'root');assert.equal(event.agentId,'child');assert.equal(event.kind,'child_start');
});
test('corrupt and partial spool files preserve valid events and replays', () => {
  const root=mkdtempSync(join(tmpdir(),'ade-spool-'));const store=new EventStore(':memory:');
  const event=normalizeHook('claude',{hook_event_name:'SessionStart',session_id:'s1'},{});
  assert.equal(spoolHook(event,root),true);writeFileSync(join(root,'broken.json'),'broken');writeFileSync(join(root,'partial.tmp'),'partial');
  const issues=importSpool(root,store);assert.equal(store.events().length,1);assert.equal(issues.length,1);
  spoolHook(event,root);importSpool(root,store);assert.equal(store.events().length,1);store.close();rmSync(root,{recursive:true});
});
