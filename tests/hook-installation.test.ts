import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,readdirSync,symlinkSync,existsSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFileSync} from 'node:child_process';
import {HookInstallation} from '../src/capture/hook-installation.ts';
import {EventStore} from '../src/capture/store.ts';
function fixture(){const home=mkdtempSync(join(tmpdir(),'ade-user-hooks-')),output=join(home,'capture'),db=new EventStore(join(output,'events.sqlite'));const manager=new HookInstallation(output,{home,env:{}});return {home,output,db,manager,close(){db.close();rmSync(home,{recursive:true});}};}
test('first-run choice persists and user installs are idempotent while preserving other hooks',async()=>{
 const f=fixture();try{
  mkdirSync(join(f.home,'.claude'));const path=join(f.home,'.claude/settings.json');writeFileSync(path,JSON.stringify({theme:'dark',hooks:{Stop:[{hooks:[{type:'command',command:'other'}]}]}}));
  assert.equal(f.manager.status().setupSeen,false);await f.manager.install('claude');await f.manager.install('claude');
  const config=JSON.parse(readFileSync(path,'utf8'));assert.equal(config.theme,'dark');assert.equal(config.hooks.Stop.length,2);assert.equal(config.hooks.Stop[0].hooks[0].command,'other');
  assert.equal(f.manager.status().targets.find(t=>t.provider==='claude')?.state,'installed');
  f.manager.dismiss();assert.equal(new HookInstallation(f.output,{home:f.home,env:{}}).status().setupSeen,true);
  const target=f.manager.status().targets.find(t=>t.provider==='claude')!;
  const command=config.hooks.SessionStart[0].hooks[0].command;
  execFileSync('/bin/sh',['-c',command],{input:JSON.stringify({hook_event_name:'SessionStart',session_id:'test-session',cwd:'/test',prompt:'secret'}),timeout:5000});
  const files=readdirSync(join(f.output,'spool'));assert.equal(files.length,1);const event=JSON.parse(readFileSync(join(f.output,'spool',files[0]),'utf8'));assert.equal(event.sessionId,'test-session');assert.ok(event.runtimeId.includes(target.id));assert.ok(!JSON.stringify(event).includes('secret'));f.db.put(event);assert.equal(f.manager.status().targets.find(t=>t.id===target.id)?.lastEvent,event.observedAt);assert.equal(f.manager.status().targets.find(t=>t.provider==='codex')?.lastEvent,null);
 }finally{f.close();}
});
test('a stable hook command survives runtime refresh at startup',async()=>{
 const f=fixture();try{
  await f.manager.install('codex');const configPath=join(f.home,'.codex/hooks.json'),before=readFileSync(configPath,'utf8');
  const command=JSON.parse(before).hooks.SessionStart[0].hooks[0].command;
  assert.ok(command.includes('/hook-runtime/launch.sh'));assert.ok(!command.includes(f.manager.status().runtimeVersion));
  const current=join(f.home,'Library/Application Support/studio.ezyo.agenttime/hook-runtime/current');
  writeFileSync(current,'0000000000000000\n');
  writeFileSync(join(f.home,'Library/Application Support/studio.ezyo.agenttime/hook-runtime',f.manager.status().runtimeVersion,'node'),'damaged executable');
  const restarted=new HookInstallation(f.output,{home:f.home,env:{}});
  assert.equal(restarted.status().runtimeReady,true);
  assert.equal(restarted.status().targets.find(t=>t.provider==='codex')?.state,'installed');
  assert.equal(readFileSync(configPath,'utf8'),before);
  assert.equal(readFileSync(current,'utf8'),restarted.status().runtimeVersion+'\n');
  assert.deepEqual(restarted.cleanup().errors,[]);
  new HookInstallation(f.output,{home:f.home,env:{}});
  assert.equal(existsSync(current),false);
 }finally{f.close();}
});
test('an existing hashed command migrates once to the stable launcher',async()=>{
 const f=fixture();try{
  await f.manager.install('claude');const target=f.manager.status().targets.find(t=>t.provider==='claude')!;
  const configPath=target.path,config=JSON.parse(readFileSync(configPath,'utf8'));
  const stable=config.hooks.SessionStart[0].hooks[0].command;
  const root=join(f.home,'Library/Application Support/studio.ezyo.agenttime/hook-runtime');
  const old=[join(root,f.manager.status().runtimeVersion,'node'),join(root,f.manager.status().runtimeVersion,'hook-runner.ts'),'--provider','claude','--spool',join(f.output,'spool'),'--installation-id',target.id,'--runtime-version',f.manager.status().runtimeVersion].map(value=>"'"+value.replaceAll("'","'\\''")+"'").join(' ');
  for(const groups of Object.values(config.hooks) as any[])for(const group of groups)for(const hook of group.hooks)if(hook.command===stable)hook.command=old;
  writeFileSync(configPath,JSON.stringify(config));
  const ledger=join(f.home,'Library/Application Support/studio.ezyo.agenttime/hook-installations',target.id,'managed.json');
  writeFileSync(ledger,JSON.stringify({path:configPath,commands:[old]}));
  assert.equal(f.manager.status().targets.find(t=>t.id===target.id)?.state,'needs-update');
  await f.manager.install('claude');
  const updated=JSON.parse(readFileSync(configPath,'utf8'));
  assert.equal(updated.hooks.SessionStart.length,1);
  assert.equal(updated.hooks.SessionStart[0].hooks[0].command,stable);
  assert.equal(f.manager.status().targets.find(t=>t.id===target.id)?.state,'installed');
 }finally{f.close();}
});
test('Orca account homes and explicit provider homes are covered without treating Claude auth directories as settings',()=>{
 const f=fixture();try{
  const base=join(f.home,'Library/Application Support/orca');mkdirSync(join(base,'codex-accounts/account/home'),{recursive:true});writeFileSync(join(base,'codex-accounts/account/home/config.toml'),'');
  mkdirSync(join(base,'claude-accounts/auth-only/auth'),{recursive:true});mkdirSync(join(base,'claude-accounts/config/home/projects'),{recursive:true});
  const manager=new HookInstallation(f.output,{home:f.home,env:{CODEX_HOME:join(f.home,'custom-codex'),CLAUDE_CONFIG_DIR:join(f.home,'custom-claude')}});
  const targets=manager.status().targets;assert.ok(targets.some(t=>t.path===join(f.home,'custom-codex/hooks.json')));assert.ok(targets.some(t=>t.path===join(f.home,'custom-claude/settings.json')));assert.ok(targets.some(t=>t.path===join(base,'codex-accounts/account/home/hooks.json')));assert.ok(!targets.some(t=>t.path.includes('auth-only')));
 }finally{f.close();}
});
test('an Orca account inheriting the user Codex hooks stays installed after sync',async()=>{
 const f=fixture();try{
  const account=join(f.home,'Library/Application Support/orca/codex-accounts/account/home');mkdirSync(account,{recursive:true});
  await f.manager.install('codex');
  const user=join(f.home,'.codex/hooks.json'),accountHooks=join(account,'hooks.json');
  assert.equal(f.manager.status().targets.find(t=>t.path===accountHooks)?.state,'installed');
  writeFileSync(accountHooks,readFileSync(user));
  assert.equal(f.manager.status().targets.find(t=>t.path===accountHooks)?.state,'installed');
  await f.manager.install('codex');
  writeFileSync(accountHooks,readFileSync(user));
  assert.equal(f.manager.status().targets.find(t=>t.path===accountHooks)?.state,'installed');
  assert.deepEqual(f.manager.cleanup().errors,[]);
  assert.equal(JSON.parse(readFileSync(accountHooks,'utf8')).hooks.SessionStart,undefined);
 }finally{f.close();}
});
test('an Orca account detects and removes a copied historical user hook beside its own hook',async()=>{
 const f=fixture();try{
  const account=join(f.home,'Library/Application Support/orca/codex-accounts/account/home');mkdirSync(account,{recursive:true});
  const accountHooks=join(account,'hooks.json');writeFileSync(accountHooks,JSON.stringify({hooks:{Stop:[{hooks:[{type:'command',command:'foreign-hook'}]}]}}));
  await f.manager.install('codex');
  const userTarget=f.manager.status().targets.find(t=>t.path===join(f.home,'.codex/hooks.json'))!;
  const accountTarget=f.manager.status().targets.find(t=>t.path===accountHooks)!;
  const before=readFileSync(join(f.home,'.codex/hooks.json'),'utf8');
  const version=f.manager.status().runtimeVersion,root=join(f.home,'Library/Application Support/studio.ezyo.agenttime/hook-runtime');
  const old=[join(root,version,'node'),join(root,version,'hook-runner.ts'),'--provider','codex','--spool',join(f.output,'spool'),'--installation-id',userTarget.id,'--runtime-version',version].map(value=>"'"+value.replaceAll("'","'\\''")+"'").join(' ');
  const userLedger=join(f.home,'Library/Application Support/studio.ezyo.agenttime/hook-installations',userTarget.id,'managed.json');
  const record=JSON.parse(readFileSync(userLedger,'utf8'));record.commands.push(old);writeFileSync(userLedger,JSON.stringify(record));
  const config=JSON.parse(readFileSync(accountHooks,'utf8'));
  for(const [event,groups] of Object.entries(config.hooks) as [string,any[]][])groups.splice(groups.length-1,0,{hooks:[{type:'command',command:old,timeout:2,statusMessage:`Agent Time: ${event}`}]});
  writeFileSync(accountHooks,JSON.stringify(config));
  assert.equal(f.manager.status().targets.find(t=>t.id===accountTarget.id)?.state,'needs-update');
  await f.manager.install('codex');
  const updated=JSON.parse(readFileSync(accountHooks,'utf8'));
  for(const groups of Object.values(updated.hooks) as any[])assert.equal(groups.flatMap((group:any)=>group.hooks).filter((hook:any)=>hook.command.includes('/hook-runtime/')).length,1);
  assert.equal(updated.hooks.Stop.flatMap((group:any)=>group.hooks).filter((hook:any)=>hook.command==='foreign-hook').length,1);
  assert.equal(readFileSync(join(f.home,'.codex/hooks.json'),'utf8'),before);
  assert.equal(f.manager.status().targets.find(t=>t.id===accountTarget.id)?.state,'installed');
 }finally{f.close();}
});
test('malformed or symlinked user configs are reported and never replaced',async()=>{
 const f=fixture();try{
  mkdirSync(join(f.home,'.codex'));const p=join(f.home,'.codex/hooks.json');writeFileSync(p,'broken');assert.equal(f.manager.status().targets.find(t=>t.provider==='codex')?.state,'error');
  await f.manager.install('codex');assert.equal(readFileSync(p,'utf8'),'broken');
  rmSync(p);const other=join(f.home,'other.json');writeFileSync(other,'{}');symlinkSync(other,p);await f.manager.install('codex');assert.equal(readFileSync(other,'utf8'),'{}');
 }finally{f.close();}
});
test('changed managed hooks are repaired without duplicate entries or erasing concurrent additions',async()=>{
 const f=fixture();try{
  await f.manager.install('codex');const path=join(f.home,'.codex/hooks.json'),config=JSON.parse(readFileSync(path,'utf8'));
  config.hooks.Stop[0].hooks.push({type:'command',command:'concurrent'});config.hooks.Stop[0].hooks[0].timeout=1;delete config.hooks.PreToolUse;writeFileSync(path,JSON.stringify(config));
  assert.equal(f.manager.status().targets.find(t=>t.provider==='codex')?.state,'needs-update');await f.manager.install('codex');
  const next=JSON.parse(readFileSync(path,'utf8'));const handlers=next.hooks.Stop.flatMap((g:any)=>g.hooks);assert.equal(handlers.filter((h:any)=>h.command==='concurrent').length,1);assert.equal(handlers.length,2);assert.equal(next.hooks.PreToolUse.length,1);
 }finally{f.close();}
});
test('user-scope installation migrates only project hooks recorded in our manifest',async()=>{
 const f=fixture();try{
  const {prepareConfig,applyConfig}=await import('../src/capture/hook-config.ts');const path=join(f.home,'project/.claude/settings.local.json');mkdirSync(join(f.home,'project/.claude'),{recursive:true});writeFileSync(path,JSON.stringify({hooks:{Stop:[{hooks:[{type:'command',command:'project-other'}]}]}}));
  const manifest=prepareConfig(path,'claude','legacy-agent-time',['Stop','SessionStart']);applyConfig(manifest);writeFileSync(join(f.output,'claude-hook-manifest.json'),JSON.stringify(manifest));
  assert.deepEqual(f.manager.status().legacyPaths,[path]);await f.manager.install('claude');
  const config=JSON.parse(readFileSync(path,'utf8'));assert.equal(config.hooks.Stop.length,1);assert.equal(config.hooks.Stop[0].hooks[0].command,'project-other');assert.equal(config.hooks.SessionStart,undefined);assert.deepEqual(f.manager.status().legacyPaths,[]);
 }finally{f.close();}
});
test('moving the capture data directory updates the owned command instead of installing duplicates',async()=>{
 const f=fixture();try{
  await f.manager.install('claude');f.manager.dismiss();const moved=new HookInstallation(join(f.home,'new-data'),{home:f.home,env:{}});assert.equal(moved.status().setupSeen,true);assert.equal(moved.status().targets.find(t=>t.provider==='claude')?.state,'needs-update');
  await moved.install('claude');const config=JSON.parse(readFileSync(join(f.home,'.claude/settings.json'),'utf8'));assert.equal(config.hooks.Stop.length,1);assert.ok(config.hooks.Stop[0].hooks[0].command.includes('new-data/spool'));
 }finally{f.close();}
});
test('a removed managed hook requests repair, while intentional cleanup does not',async()=>{
 const f=fixture();try{
  await f.manager.install('claude');const path=join(f.home,'.claude/settings.json');
  rmSync(path);assert.equal(f.manager.status().targets.find(t=>t.provider==='claude')?.state,'needs-update');
  await f.manager.install('claude');assert.equal(f.manager.status().targets.find(t=>t.provider==='claude')?.state,'installed');
  assert.deepEqual(f.manager.cleanup().errors,[]);assert.equal(f.manager.status().targets.find(t=>t.provider==='claude')?.state,'not-installed');
 }finally{f.close();}
});
test('cleanup previews and removes only owned hooks including inactive custom homes, keeping history and foreign handlers',async()=>{
 const f=fixture();try{
  const custom=join(f.home,'custom'),m=new HookInstallation(f.output,{home:f.home,env:{CODEX_HOME:custom}});await m.install('codex');
  const path=join(custom,'hooks.json'),config=JSON.parse(readFileSync(path,'utf8'));config.theme='dark';config.hooks.Stop[0].hooks.push({command:'foreign',type:'command'});writeFileSync(path,JSON.stringify(config));
  const before=readFileSync(join(f.output,'events.sqlite'));const preview=f.manager.cleanupPreview();assert.ok(preview.configurations.includes(path));assert.ok(preview.helpers.length);assert.equal(readFileSync(path,'utf8'),JSON.stringify(config));
  const result=f.manager.cleanup();assert.deepEqual(result.errors,[]);const after=JSON.parse(readFileSync(path,'utf8'));assert.equal(after.theme,'dark');assert.deepEqual(after.hooks.Stop[0].hooks,[{command:'foreign',type:'command'}]);assert.equal(after.hooks.SessionStart,undefined);assert.deepEqual(readFileSync(join(f.output,'events.sqlite')),before);assert.equal(f.manager.status().runtimeReady,false);assert.deepEqual(f.manager.cleanup().errors,[]);await m.install('codex');assert.equal(m.status().targets.filter(t=>t.provider==='codex').every(t=>t.state==='installed'),true);
 }finally{f.close();}
});
test('cleanup retains runtimes when an owned configuration cannot safely be edited',async()=>{
 const f=fixture();try{await f.manager.install('claude');const path=join(f.home,'.claude/settings.json');writeFileSync(path,'malformed');assert.ok(f.manager.cleanupPreview().errors.length);const result=f.manager.cleanup();assert.ok(result.errors.length);assert.equal(readFileSync(path,'utf8'),'malformed');assert.equal(f.manager.status().runtimeReady,true);}finally{f.close();}
});
test('cleanup handles merged legacy project hooks and retains unexpected runtime files',async()=>{
 const f=fixture();try{
  const {prepareConfig,applyConfig}=await import('../src/capture/hook-config.ts');const path=join(f.home,'project/.claude/settings.local.json');const manifest=prepareConfig(path,'claude','legacy-agent-time',['Stop']);applyConfig(manifest);writeFileSync(join(f.output,'claude-hook-manifest.json'),JSON.stringify(manifest));const config=JSON.parse(readFileSync(path,'utf8'));config.hooks.Stop[0].hooks.push({command:'foreign'});writeFileSync(path,JSON.stringify(config));
  assert.deepEqual(f.manager.cleanupPreview().configurations,[path]);assert.deepEqual(f.manager.cleanup().errors,[]);assert.deepEqual(JSON.parse(readFileSync(path,'utf8')).hooks.Stop[0].hooks,[{command:'foreign'}]);assert.deepEqual(f.manager.cleanup().removedConfigurations,[]);
  await f.manager.install('codex');const runtime=f.manager.cleanupPreview().helpers.find(path=>statSync(path).isDirectory())!;writeFileSync(join(runtime,'keep.txt'),'user file');assert.ok(f.manager.cleanup().errors.length);assert.equal(readFileSync(join(runtime,'keep.txt'),'utf8'),'user file');assert.equal(f.manager.status().runtimeReady,true);
 }finally{f.close();}
});
