import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {Collector} from '../src/capture/collector.ts';import {makeEvent} from '../src/capture/events.ts';import {storedSettings} from '../src/capture/settings.ts';

test('legacy website preference migrates to individual browsers',()=>{
 const disabled=storedSettings({browserTracking:false});
 assert.equal(disabled.browserSafari,false);assert.equal(disabled.browserChrome,false);assert.equal(disabled.browserBrave,false);
 const mixed=storedSettings({browserTracking:false,browserBrave:true});
 assert.equal(mixed.browserSafari,false);assert.equal(mixed.browserBrave,true);
});
test('missing Orca CLI skips polling while agent hooks keep capturing',async()=>{
 const {spoolHook,normalizeHook}=await import('../src/capture/hooks.ts');
 const path=mkdtempSync(join(tmpdir(),'ade-no-orca-')),previous=process.env.ORCA_CLI_COMMAND;
 process.env.ORCA_CLI_COMMAND=join(path,'missing-orca');
 const c=new Collector(path);
 try{
  c.updateSettings({macosActivity:false,tokenUsage:false});
  spoolHook(normalizeHook('codex',{hook_event_name:'SessionStart',session_id:'session-without-orca'},{}),join(path,'spool'));
  const status=await c.start(5);
  assert.equal(status.running,true);assert.equal(status.orcaAvailable,false);assert.equal(status.orcaPolling,false);
  assert.equal(status.surfaces.orcaPolling,true);assert.equal(status.lastError,null);
  assert.ok(c.store.events().some(event=>event.source==='hook'&&event.sessionId==='session-without-orca'));
  assert.ok(!c.store.events().some(event=>event.source==='orca'));
 }finally{
  await c.close();rmSync(path,{recursive:true});
  if(previous===undefined)delete process.env.ORCA_CLI_COMMAND;else process.env.ORCA_CLI_COMMAND=previous;
 }
});

test('disabled browser page details are discarded while foreground activity remains',async()=>{
 const {writeFileSync,readFileSync}=await import('node:fs');const {setTimeout:sleep}=await import('node:timers/promises');
 const output=mkdtempSync(join(tmpdir(),'ade-browser-switch-')),helper=join(output,'probe'),argsFile=join(output,'args');
 const safari=JSON.stringify({kind:'activity',foregroundBundleId:'com.apple.Safari',idleSeconds:0,uptime:100,accessibilityTrusted:true,browserDomain:'example.com',browserUrl:'https://example.com/safari',browserTitle:'Safari page'});
 const brave=JSON.stringify({kind:'activity',foregroundBundleId:'com.brave.Browser',idleSeconds:0,uptime:100,accessibilityTrusted:true,browserDomain:'example.com',browserUrl:'https://example.com/brave',browserTitle:'Brave page'});
 writeFileSync(helper,`#!/bin/sh\nprintf '%s' "$*" > '${argsFile}'\necho '${safari}'\necho '${brave}'\nexec /bin/sleep 5\n`,{mode:0o755});
 const c=new Collector(output,helper);c.updateSettings({orcaPolling:false,browserSafari:false,browserChrome:false,browserBrave:true});
 try{
  await c.start(30);for(let i=0;i<200&&c.store.events().filter(e=>e.kind==='activity').length<2;i++)await sleep(25);
  const samples=c.store.events().filter(e=>e.kind==='activity');
  assert.equal(samples.length,2);assert.equal(samples[0]?.data?.foregroundBundleId,'com.apple.Safari');assert.equal(samples[0]?.data?.browserUrl,undefined);
  assert.equal(samples[1]?.data?.browserUrl,'https://example.com/brave');
  assert.equal(readFileSync(argsFile,'utf8'),'--browser-brave');
 }finally{await c.close();rmSync(output,{recursive:true});}
});

test('changing one browser restarts the probe with the new enabled set',async()=>{
 const {writeFileSync,readFileSync,existsSync}=await import('node:fs');const {setTimeout:sleep}=await import('node:timers/promises');
 const output=mkdtempSync(join(tmpdir(),'ade-browser-restart-')),helper=join(output,'probe'),log=join(output,'launches');
 writeFileSync(helper,`#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec /bin/sleep 10\n`,{mode:0o755});
 const c=new Collector(output,helper);c.updateSettings({orcaPolling:false});
 const launches=()=>readFileSync(log,'utf8').trim().split('\n');
 try{
  await c.start(30);for(let i=0;i<80&&!existsSync(log);i++)await sleep(25);
  c.updateSettings({browserChrome:false});for(let i=0;i<80&&launches().length<2;i++)await sleep(25);
  assert.equal(launches().at(-1),'--browser-safari --browser-brave');
  c.updateSettings({browserChrome:true});for(let i=0;i<80&&launches().length<3;i++)await sleep(25);
  assert.equal(launches().at(-1),'--browser-safari --browser-chrome --browser-brave');
 }finally{await c.close();rmSync(output,{recursive:true});}
});
test('surface changes persist, discard disabled hook backlog, and preserve enabled providers',async()=>{
 const {spoolHook,normalizeHook}=await import('../src/capture/hooks.ts');
 const path=mkdtempSync(join(tmpdir(),'ade-surfaces-'));let c=new Collector(path);
 try{
  c.updateSettings({orcaPolling:false,macosActivity:false,claudeHooks:false,humanIdleMinutes:10,agentIdleMinutes:2});
  await c.start(30);
  spoolHook(normalizeHook('claude',{hook_event_name:'Stop',session_id:'disabled'},{}),join(path,'spool'));
  spoolHook(normalizeHook('codex',{hook_event_name:'Stop',session_id:'enabled'},{}),join(path,'spool'));
  c.updateSettings({claudeHooks:true});await c.stop();
  assert.ok(!c.store.events().some(e=>e.sessionId==='disabled'));
  assert.ok(c.store.events().some(e=>e.sessionId==='enabled'));
  await c.close();c=new Collector(path);assert.equal(c.status().surfaces.claudeHooks,true);assert.equal(c.status().surfaces.macosActivity,false);assert.equal(c.status().orcaPolling,false);assert.equal(c.status().surfaces.humanIdleMinutes,10);assert.equal(c.status().surfaces.agentIdleMinutes,2);
  assert.throws(()=>c.updateSettings({orcaPolling:'yes'} as any));
  for(const invalid of [0,-1,1.5,61,NaN,Infinity,'5'])assert.throws(()=>c.updateSettings({agentIdleMinutes:invalid} as any));
 }finally{await c.close();rmSync(path,{recursive:true});}
});
test('saved idle controls change the dashboard summary without restarting capture',async()=>{
 const path=mkdtempSync(join(tmpdir(),'ade-idle-controls-')),c=new Collector(path);
 const root={hostId:'local',terminalHandle:'term',sessionId:'session',provider:'codex'};
 try{
  c.store.put(makeEvent('hook','prompt_submitted',{...root,observedAt:1000,monotonicAt:1000}));
  c.store.put(makeEvent('hook','response_stop',{...root,observedAt:1180,monotonicAt:1180}));
  c.store.put(makeEvent('macos','activity',{observedAt:2000,monotonicAt:2000,data:{foregroundBundleId:'test',idleSeconds:90}}));
  c.store.put(makeEvent('macos','activity',{observedAt:2005,monotonicAt:2005,data:{foregroundBundleId:'test',idleSeconds:90}}));
  assert.equal(c.summary().agentSeconds,180);assert.equal(c.summary().humanSeconds,60);
  c.updateSettings({agentIdleMinutes:2,humanIdleMinutes:1});
  assert.equal(c.summary().agentSeconds,120);assert.equal(c.summary().humanSeconds,0);
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
test('Accessibility grant restarts only the probe and exposes raw and matched Orca IDs',async()=>{
 const {writeFileSync}=await import('node:fs');const {setTimeout:sleep}=await import('node:timers/promises');
 const path=mkdtempSync(join(tmpdir(),'ade-live-ax-')),helper=join(path,'probe'),grant=join(path,'granted');
 const falseSample=JSON.stringify({kind:'activity',foregroundBundleId:'com.stablyai.orca',foregroundName:'Orca',idleSeconds:0,uptime:100,accessibilityTrusted:false});
 const trueSample=JSON.stringify({kind:'activity',foregroundBundleId:'com.stablyai.orca',foregroundName:'Orca',idleSeconds:0,uptime:100,accessibilityTrusted:true,orcaWindowTitle:'Orca',orcaSelectedTabTitle:'Review project',orcaSelectedWorktreeId:'host::/project'});
 writeFileSync(helper,`#!/bin/sh\nif [ "$1" = "--trust-only" ]; then if [ -f "${grant}" ]; then echo '{"accessibilityTrusted":true}'; else echo '{"accessibilityTrusted":false}'; fi; exit; fi\nif [ -f "${grant}" ]; then echo '${trueSample}'; else echo '${falseSample}'; fi\nexec /bin/sleep 30\n`,{mode:0o755});
 const layout={ok:true,result:{visualLayouts:[{worktreeId:'host::/project',root:{tabs:[{tabId:'tab-1',title:'Review project',activeLeafId:'leaf-1',panes:{type:'terminal',leafId:'leaf-1',handle:'term-1'}}]}}]}};
 const c=new Collector(path,helper,1,undefined,async()=>layout);c.updateSettings({orcaPolling:false});
 try{
  await c.start(30);for(let i=0;i<200&&c.status().macos?.accessibilityTrusted!==false;i++)await sleep(20);
  assert.equal(c.status().macos?.accessibilityTrusted,false);
  writeFileSync(grant,'');await (c as any).refreshProbeTrust();
  for(let i=0;i<200&&c.status().macos?.accessibilityTrusted!==true;i++)await sleep(20);
  assert.equal(c.status().running,true);assert.equal(c.status().macos?.accessibilityTrusted,true);
  const accessibility=c.captureHealth().accessibility;
  assert.equal(accessibility?.selectedWorktreeId,'host::/project');assert.equal(accessibility?.selectedTabTitle,'Review project');
  assert.deepEqual(accessibility?.resolved,{workspaceId:'host::/project',tabId:'tab-1',leafId:'leaf-1',terminalHandle:'term-1'});
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
test('new data store drains hooks from an old store until active sessions restart',async()=>{
 const {writeFileSync,existsSync,readdirSync,readFileSync}=await import('node:fs');const {spoolHook,normalizeHook}=await import('../src/capture/hooks.ts');
 const root=mkdtempSync(join(tmpdir(),'ade-moved-store-')),path=join(root,'current'),oldSpool=join(root,'previous','spool');
 const {mkdirSync}=await import('node:fs');mkdirSync(path,{recursive:true});
 writeFileSync(join(path,'settings.json'),JSON.stringify({orcaPolling:false,macosActivity:false,legacyHookSpools:[oldSpool]}));
 const c=new Collector(path);
 try{
  assert.equal(spoolHook(normalizeHook('claude',{hook_event_name:'SessionStart',session_id:'old-session'},{}),oldSpool),true);
  await c.start(5);
  assert.ok(c.store.events().some(e=>e.source==='hook'&&e.sessionId==='old-session'));
  assert.deepEqual(readdirSync(oldSpool),[]);
  c.updateSettings({claudeHooks:false});
  assert.deepEqual(JSON.parse(readFileSync(join(path,'settings.json'),'utf8')).legacyHookSpools,[oldSpool]);
  assert.equal(existsSync(join(root,'previous','events.sqlite')),false);
 }finally{await c.close();rmSync(root,{recursive:true});}
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
  const e=makeEvent('hook','session_start',{provider:'claude',sessionId:'new',hostId:'local'});c.store.put(e);assert.notDeepEqual(c.summary(),first);c.trayStatus();assert.equal(reads,1);
  c.store.put(e);c.summary();assert.equal(reads,1);
  const db=new DatabaseSync(join(path,'events.sqlite')),other=makeEvent('hook','session_start',{provider:'codex',sessionId:'external',hostId:'local'});db.prepare('INSERT INTO events VALUES(?,?,?)').run(other.eventId,other.observedAt,JSON.stringify(other));db.close();assert.ok(c.summary().sessions.some(s=>s.sessionId==='external'));assert.equal(reads,2);
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
test('selected Orca worktree samples remain project-attributed when no tab metadata matches',async()=>{
 const {writeFileSync}=await import('node:fs');const {setTimeout:sleep}=await import('node:timers/promises');
 const path=mkdtempSync(join(tmpdir(),'ade-worktree-focus-')),helper=join(path,'probe');
 const activity=JSON.stringify({kind:'activity',foregroundBundleId:'com.stablyai.orca',idleSeconds:0,uptime:100,accessibilityTrusted:true,orcaSelectedWorktreeId:'workspace-1',orcaSelectedTabTitle:'Unmatched tab'});
 writeFileSync(helper,`#!/bin/sh\nsleep .2\necho '${activity}'\nsleep .2\necho '${activity}'\n`,{mode:0o755});
 const c=new Collector(path,helper,5,undefined,async()=>({ok:true,result:{visualLayouts:[]}}));c.updateSettings({orcaPolling:false});
 try{await c.start(30);for(let i=0;i<60&&c.store.events().filter(e=>e.kind==='activity').length<2;i++)await sleep(50);const samples=c.store.events().filter(e=>e.kind==='activity');assert.equal(samples.length,2);assert.ok(samples.every(e=>e.workspaceId==='workspace-1'&&e.data?.tabId===undefined));const interval=c.summary().intervals.find(i=>i.state==='human');assert.equal(interval?.workspaceId,'workspace-1');assert.equal(interval?.tabId,undefined);}
 finally{await c.close();rmSync(path,{recursive:true});}
});
test('a website rule attributes stable browser time to a project without creating an agent session',async()=>{
 const {writeFileSync,mkdirSync}=await import('node:fs');const {setTimeout:sleep}=await import('node:timers/promises');
 const output=mkdtempSync(join(tmpdir(),'ade-website-rule-')),project=join(output,'project'),helper=join(output,'probe');mkdirSync(project);
 const activity=JSON.stringify({kind:'activity',foregroundBundleId:'com.brave.Browser',foregroundName:'Brave Browser',idleSeconds:0,uptime:100,accessibilityTrusted:true,browserDomain:'localhost',browserUrl:'http://localhost:1420/page',browserTitle:'Page'});
 writeFileSync(helper,`#!/bin/sh\necho '${activity}'\nsleep .2\necho '${activity}'\nsleep .2\necho '${activity}'\nexec /bin/sleep 5\n`,{mode:0o755});
 const c=new Collector(output,helper,5,undefined,async()=>({ok:true,result:{terminals:[],visualLayouts:[]}}));c.updateSettings({orcaPolling:false});c.setWebsiteRule('http://localhost:1420',project);
 try{
  await c.start(30);
  for(let i=0;i<80&&c.store.events().filter(e=>e.kind==='activity').length<3;i++)await sleep(25);
  const samples=c.store.events().filter(e=>e.kind==='activity');assert.equal(samples.length,3);
  assert.equal(samples.at(-1)?.workspaceId,'web::'+project);
  assert.equal(c.summary().sessions.length,0);
  assert.ok(c.summary().intervals.some(i=>i.state==='human'&&i.workspaceId==='web::'+project&&i.browserOrigin==='http://localhost:1420'));
  const reconciliation=c.captureHealth().websites.find(site=>site.key==='http://localhost:1420');
  assert.equal(reconciliation?.projectPath,project);assert.equal(reconciliation?.source,'rule');assert.ok(reconciliation?.appliedAt);
 }finally{await c.close();rmSync(output,{recursive:true});}
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
test('repeated Orca polls retain one settled worker and one unchanged terminal',async()=>{
 const {setTimeout:sleep}=await import('node:timers/promises');
 const path=mkdtempSync(join(tmpdir(),'ade-orca-retention-'));
 const worker={runId:'run',taskId:'task',dispatchId:'dispatch',agentTerminalHandle:'term',resource:{worktreeId:'workspace',terminalHandle:'term'},projection:{host:{id:'host'},workspace:{id:'workspace'},stage:{activity:'unknown'},evidence:{liveStatus:'stale'},outcome:'succeeded'}};
 const terminal={executionHostId:'host',worktreeId:'workspace',worktreePath:'/tmp/workspace',handle:'term',incarnationId:'incarnation',agentIdentity:'claude',title:'Agent',connected:true};
 let terminalReads=0;
 const reader=async(args:string[])=>{
  if(args[0]==='terminal'){terminalReads++;return {ok:true,result:{terminals:[terminal]}};}
  if(args[1]==='run-list')return {ok:true,result:{runs:[{id:'run'}],nextCursor:null}};
  return {ok:true,result:{workers:[worker],page:{hasMore:false}}};
 };
 const c=new Collector(path,undefined,1,undefined,reader);c.updateSettings({macosActivity:false});
 try{
  await c.start(5);
  for(let i=0;i<40&&terminalReads<2;i++)await sleep(50);
  assert.ok(terminalReads>=2);
  assert.equal(c.store.events().filter(e=>e.kind==='worker').length,1);
  assert.equal(c.store.events().filter(e=>e.kind==='terminal').length,1);
 }finally{await c.close();rmSync(path,{recursive:true});}
});
