import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {Collector} from '../src/capture/collector.ts';import {makeEvent} from '../src/capture/events.ts';
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
 const c=new Collector(path,undefined,5,undefined,async()=>{calls++;return pending;});c.updateSettings({macosActivity:false});const started=c.start(30);
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
  await c.start(30);for(let i=0;i<300&&!existsSync(pidfile);i++)await sleep(10);
  const pid=Number(readFileSync(pidfile,'utf8'));c.updateSettings({macosActivity:false});await sleep(50);assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});assert.equal(c.status().running,true);
  c.updateSettings({macosActivity:true});for(let i=0;i<300&&Number(readFileSync(pidfile,'utf8'))===pid;i++)await sleep(10);
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
 const c=new Collector(path,helper,5,undefined,async(argv)=>{calls++;return argv[0]==='terminal'?{ok:true,result:{terminals:[],visualLayouts:[]}}:pending;});const started=c.start(30);
 for(let i=0;i<300&&!existsSync(pidfile);i++)await sleep(10);
 const pid=Number(readFileSync(pidfile,'utf8'));const stopped=c.stop();await sleep(50);
 try { assert.throws(()=>process.kill(pid,0),{code:'ESRCH'}); } finally {
  release({ok:true,result:{runs:[{id:'r1'}],nextCursor:null}});await Promise.all([started,stopped]);await c.close();rmSync(path,{recursive:true});
 }
 assert.equal(calls,2);
});
test('persisted polling disable skips Orca reads while importing hook events',async()=>{
 const {writeFileSync}=await import('node:fs');const {spoolHook,normalizeHook}=await import('../src/capture/hooks.ts');
 const path=mkdtempSync(join(tmpdir(),'ade-hook-only-'));writeFileSync(join(path,'settings.json'),JSON.stringify({orcaPolling:false,macosActivity:false}));
 let calls=0;const c=new Collector(path,undefined,1,undefined,async()=>{calls++;throw new Error('Orca must not be called');});
 spoolHook(normalizeHook('claude',{hook_event_name:'SessionStart',session_id:'test-session'},{}),join(path,'spool'));
 try{await c.start(5);assert.equal(calls,0);assert.equal(c.status().orcaPolling,false);assert.ok(c.store.events().some(e=>e.source==='hook'&&e.sessionId==='test-session'));assert.ok(!c.store.events().some(e=>e.source==='orca'));}
 finally{await c.close();rmSync(path,{recursive:true});}
});
test('existing shared usage settings migrate to per-agent controls and retain independent preferences',async()=>{
 const {writeFileSync}=await import('node:fs');const path=mkdtempSync(join(tmpdir(),'ade-provider-settings-'));writeFileSync(join(path,'settings.json'),JSON.stringify({tokenUsage:true}));let c=new Collector(path);
 try{
  assert.equal(c.status().surfaces.claudeTokenUsage,true);assert.equal(c.status().surfaces.codexTokenUsage,true);
  c.updateSettings({claudeTokenUsage:false,codexTokenUsage:true,claudeHooks:false,codexHooks:false});assert.equal(c.status().surfaces.macosActivity,true);assert.equal(c.status().surfaces.orcaPolling,true);
  await c.close();c=new Collector(path);assert.equal(c.status().surfaces.claudeTokenUsage,false);assert.equal(c.status().surfaces.codexTokenUsage,true);assert.equal(c.status().surfaces.tokenUsage,true);
 }finally{await c.close();rmSync(path,{recursive:true});}
});
test('status avoids history replay and dashboard/menu reuse a summary until an event changes',async()=>{
 const {makeEvent}=await import('../src/capture/events.ts');const {DatabaseSync}=await import('node:sqlite');const path=mkdtempSync(join(tmpdir(),'ade-summary-cache-'));const c=new Collector(path);
 const read=c.store.events.bind(c.store);let reads=0;c.store.events=()=>{reads++;return read();};
 try{
  c.status();assert.equal(reads,0);const first=c.summary();c.summary();c.trayStatus();assert.equal(reads,1);
  const e=makeEvent('hook','session_start',{provider:'claude',sessionId:'new',hostId:'local'});c.store.put(e);assert.notDeepEqual(c.summary(),first);c.trayStatus();assert.equal(reads,2);
  c.store.put(e);c.summary();assert.equal(reads,2);
  const db=new DatabaseSync(join(path,'events.sqlite')),other=makeEvent('hook','session_start',{provider:'codex',sessionId:'external',hostId:'local'});db.prepare('INSERT INTO events VALUES(?,?,?)').run(other.eventId,other.observedAt,JSON.stringify(other));db.close();assert.ok(c.summary().sessions.some(s=>s.sessionId==='external'));assert.equal(reads,3);
 }finally{await c.close();rmSync(path,{recursive:true});}
});
test('Orca tab metadata remains independent of worker polling and never blocks capture',async()=>{
 const path=mkdtempSync(join(tmpdir(),'ade-focus-read-'));let release!:(value:unknown)=>void;const pending=new Promise(resolve=>{release=resolve;});const calls:string[][]=[];
 const c=new Collector(path,undefined,5,undefined,async argv=>{calls.push(argv);return pending;});c.updateSettings({orcaPolling:false});
 try{
  await Promise.race([c.start(30),new Promise((_,reject)=>setTimeout(()=>reject(new Error('capture waited for focus metadata')),300))]);
  assert.equal(c.status().running,true);assert.deepEqual(calls[0]?.slice(0,2),['terminal','list']);assert.ok(!calls.some(args=>args[0]==='orchestration'));
 }finally{await c.close();release({ok:true,result:{terminals:[],visualLayouts:[]}});rmSync(path,{recursive:true});}
});
test('selected Orca terminal samples become workspace and tab intervals without worker polling',async()=>{
 const {writeFileSync}=await import('node:fs');const {setTimeout:sleep}=await import('node:timers/promises');
 const path=mkdtempSync(join(tmpdir(),'ade-focus-integration-')),helper=join(path,'probe');
 const activity=JSON.stringify({kind:'activity',foregroundBundleId:'com.stablyai.orca',foregroundName:'Orca',idleSeconds:0,uptime:100,accessibilityTrusted:true,orcaSelectedTabTitle:'Write spec'});
 writeFileSync(helper,`#!/bin/sh\nsleep .2\necho '${activity}'\nsleep .2\necho '${activity}'\n`,{mode:0o755});
 const layout={ok:true,result:{visualLayouts:[{worktreeId:'workspace-1',root:{tabs:[{tabId:'tab-1',title:'Write spec',activeLeafId:'leaf-1',panes:{type:'terminal',leafId:'leaf-1',handle:'term-1'}}]}}]}};
 const c=new Collector(path,helper,5,undefined,async()=>layout);c.updateSettings({orcaPolling:false});
 try{await c.start(30);for(let i=0;i<60&&c.store.events().filter(e=>e.kind==='activity').length<2;i++)await sleep(50);const samples=c.store.events().filter(e=>e.kind==='activity');assert.equal(samples.length,2);assert.ok(samples.every(e=>e.workspaceId==='workspace-1'&&e.data?.tabId==='tab-1'));assert.equal(c.summary().intervals.find(i=>i.state==='human')?.tabId,'tab-1');}
 finally{await c.close();rmSync(path,{recursive:true});}
});
test('display summaries can lag briefly while an exact summary sees new capture',async()=>{
 const path=mkdtempSync(join(tmpdir(),'ade-summary-age-')),c=new Collector(path);
 try{
  const first=c.summary();
  c.store.put(makeEvent('hook','session_start',{provider:'claude',sessionId:'fresh',hostId:'local'}));
  assert.equal(c.summary(15000),first);
  assert.ok(c.summary().sessions.some(s=>s.sessionId==='fresh'));
 }finally{await c.close();rmSync(path,{recursive:true});}
});
