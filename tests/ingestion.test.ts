import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync,symlinkSync,mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readWorkers,orcaCliAvailable } from '../src/capture/orca.ts';
import { normalizeHook, spoolHook, importSpool,spoolStatus } from '../src/capture/hooks.ts';
import { EventStore } from '../src/capture/store.ts';
test('all worker pages are read and repeated cursors are coverage errors', async () => {
  const pages = [{ok:true,result:{workers:[{dispatchId:'d1'}],page:{hasMore:true,nextCursor:'p2'}}},{ok:true,result:{workers:[{dispatchId:'d2'}],page:{hasMore:false}}}];
  const calls: string[][]=[];
  const result=await readWorkers(async a=>{calls.push(a);return pages.shift();}, 'r1');
  assert.equal(result.workers.length,2);assert.ok(calls[1].includes('p2')); assert.equal(result.coverage.length,0);
  const repeated=await readWorkers(async()=>({ok:true,result:{workers:[],page:{hasMore:true,nextCursor:'same'}}}));
  assert.match(repeated.coverage[0].reason,/cursor/);
});
test('Orca availability checks executable paths without launching the CLI',()=>{
 const root=mkdtempSync(join(tmpdir(),'ade-orca-path-'));
 try{
  assert.equal(orcaCliAvailable('orca',root),false);
  writeFileSync(join(root,'orca'),'#!/bin/sh\nexit 0\n',{mode:0o755});
  assert.equal(orcaCliAvailable('orca',root),true);
  assert.equal(orcaCliAvailable(join(root,'orca'),''),true);
  assert.equal(orcaCliAvailable(join(root,'missing'),root),false);
 }finally{rmSync(root,{recursive:true});}
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
  assert.equal(spoolStatus(root).pending,2);assert.equal(spoolStatus(root).temporary,1);
  const issues=importSpool(root,store);assert.equal(store.events().length,1);assert.equal(issues.length,1);
  assert.equal(spoolStatus(root).pending,1);
  spoolHook(event,root);importSpool(root,store);assert.equal(store.events().length,1);store.close();rmSync(root,{recursive:true});
});
test('hook spool rejects a directory symlink',()=>{
 const root=mkdtempSync(join(tmpdir(),'ade-spool-link-')),link=join(root,'spool'),target=join(root,'target'),store=new EventStore(':memory:');
 try{
  mkdirSync(target);symlinkSync(target,link);
  const event=normalizeHook('claude',{hook_event_name:'SessionStart',session_id:'s1'},{});
  assert.equal(spoolHook(event,link),false);
  assert.equal(spoolStatus(link).invalid,1);
  assert.throws(()=>importSpool(link,store),/Invalid hook spool directory/);
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
test('fleet discovery enumerates explicit Runs rather than inheriting coordinator binding',async()=>{
 const {readFleet}=await import('../src/capture/orca.ts');
 const calls:string[][]=[];const r=await readFleet(async argv=>{calls.push(argv);return argv[1]==='run-list'?{ok:true,result:{runs:[{id:'r1'},{id:'r2'}],nextCursor:null}}:{ok:true,result:{workers:[{dispatchId:argv[argv.indexOf('--run')+1]}],page:{hasMore:false}}};});
 assert.equal(r.workers.length,2);assert.ok(calls.slice(1).every(argv=>argv.includes('--run')));
});
test('cancelling a fleet read prevents further pages and Run batches',async()=>{
 const {readFleet}=await import('../src/capture/orca.ts');let active=true;let calls=0;
 const r=await readFleet(async argv=>{calls++;if(argv[1]==='run-list')return {ok:true,result:{runs:[{id:'r1'},{id:'r2'},{id:'r3'},{id:'r4'},{id:'r5'}],nextCursor:null}};active=false;return {ok:true,result:{workers:[],page:{hasMore:true,nextCursor:'next'}}};},()=>active);
 assert.ok(calls<=5);assert.ok(r.coverage.some(x=>x.reason.includes('cancelled')));
});
