import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {Collector} from '../src/capture/collector.ts';
test('surface changes persist, discard disabled hook backlog, and preserve enabled providers',async()=>{
 const {spoolHook,normalizeHook}=await import('../src/capture/hooks.ts');
 const path=mkdtempSync(join(tmpdir(),'ade-surfaces-'));let c=new Collector(path);
 try{
  c.updateSettings({orcaPolling:false,macosActivity:false,claudeHooks:false});
  await c.start(30);
  spoolHook(normalizeHook('claude',{hook_event_name:'Stop',session_id:'disabled'},{}),join(path,'spool'));
  spoolHook(normalizeHook('codex',{hook_event_name:'Stop',session_id:'enabled'},{}),join(path,'spool'));
  c.updateSettings({claudeHooks:true});await c.stop();
  assert.ok(!c.store.events().some(e=>e.sessionId==='disabled'));
  assert.ok(c.store.events().some(e=>e.sessionId==='enabled'));
  await c.close();c=new Collector(path);assert.equal(c.status().surfaces.claudeHooks,true);assert.equal(c.status().surfaces.macosActivity,false);assert.equal(c.status().orcaPolling,false);
  assert.throws(()=>c.updateSettings({orcaPolling:'yes'} as any));
 }finally{await c.close();rmSync(path,{recursive:true});}
});
test('disabling Orca during a read discards its late results',async()=>{
 const path=mkdtempSync(join(tmpdir(),'ade-toggle-read-'));let release!:(v:unknown)=>void;
 const pending=new Promise(resolve=>{release=resolve;});let calls=0;
 const c=new Collector(path,undefined,5,undefined,async()=>{calls++;return pending;});const started=c.start(30);
 c.updateSettings({orcaPolling:false});release({ok:true,result:{runs:[{id:'r1'}],nextCursor:null}});
 try{await started;assert.equal(calls,1);assert.ok(!c.store.events().some(e=>e.source==='orca'));}
 finally{await c.close();rmSync(path,{recursive:true});}
});
test('macOS activity can stop and restart its helper without stopping capture',async()=>{
 const {writeFileSync,existsSync,readFileSync}=await import('node:fs');const {setTimeout:sleep}=await import('node:timers/promises');
 const path=mkdtempSync(join(tmpdir(),'ade-toggle-probe-')),helper=join(path,'probe'),pidfile=join(path,'helper.pid');
 writeFileSync(helper,'#!/bin/sh\necho $$ > "'+pidfile+'"\nexec /bin/sleep 30\n',{mode:0o755});
 const c=new Collector(path,helper);c.updateSettings({orcaPolling:false});
 try{
  await c.start(30);for(let i=0;i<100&&!existsSync(pidfile);i++)await sleep(10);
  const pid=Number(readFileSync(pidfile,'utf8'));c.updateSettings({macosActivity:false});await sleep(50);assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});assert.equal(c.status().running,true);
  c.updateSettings({macosActivity:true});for(let i=0;i<100&&Number(readFileSync(pidfile,'utf8'))===pid;i++)await sleep(10);
  const nextPid=Number(readFileSync(pidfile,'utf8'));assert.notEqual(nextPid,pid);process.kill(nextPid,0);
 }finally{await c.close();rmSync(path,{recursive:true});}
});
test('an inactive observer cannot consume spool or insert capture-stop into another owners database',async()=>{
 const path=mkdtempSync(join(tmpdir(),'ade-owner-'));const c=new Collector(path);await c.stop();assert.equal(c.store.events().length,0);await c.close();rmSync(path,{recursive:true});
});
test('stop kills its native helper while a metadata read is pending and cancels remaining reads',async()=>{
 const {writeFileSync,existsSync,readFileSync}=await import('node:fs');const {setTimeout:sleep}=await import('node:timers/promises');
 const path=mkdtempSync(join(tmpdir(),'ade-stop-'));const helper=join(path,'probe');const pidfile=join(path,'helper.pid');
 writeFileSync(helper,'#!/bin/sh\necho $$ > "'+pidfile+'"\nexec /bin/sleep 30\n',{mode:0o755});
 let release!:(value:unknown)=>void;let calls=0;const pending=new Promise(resolve=>{release=resolve;});
 const c=new Collector(path,helper,5,undefined,async()=>{calls++;return pending;});const started=c.start(30);
 for(let i=0;i<100&&!existsSync(pidfile);i++)await sleep(10);
 const pid=Number(readFileSync(pidfile,'utf8'));const stopped=c.stop();await sleep(50);
 try { assert.throws(()=>process.kill(pid,0),{code:'ESRCH'}); } finally {
  release({ok:true,result:{runs:[{id:'r1'}],nextCursor:null}});await Promise.all([started,stopped]);await c.close();rmSync(path,{recursive:true});
 }
 assert.equal(calls,1);
});
test('persisted polling disable skips Orca reads while importing hook events',async()=>{
 const {writeFileSync}=await import('node:fs');const {spoolHook,normalizeHook}=await import('../src/capture/hooks.ts');
 const path=mkdtempSync(join(tmpdir(),'ade-hook-only-'));writeFileSync(join(path,'settings.json'),JSON.stringify({orcaPolling:false}));
 let calls=0;const c=new Collector(path,undefined,1,undefined,async()=>{calls++;throw new Error('Orca must not be called');});
 spoolHook(normalizeHook('claude',{hook_event_name:'SessionStart',session_id:'test-session'},{}),join(path,'spool'));
 try{await c.start(5);assert.equal(calls,0);assert.equal(c.status().orcaPolling,false);assert.ok(c.store.events().some(e=>e.source==='hook'&&e.sessionId==='test-session'));assert.ok(!c.store.events().some(e=>e.source==='orca'));}
 finally{await c.close();rmSync(path,{recursive:true});}
});
