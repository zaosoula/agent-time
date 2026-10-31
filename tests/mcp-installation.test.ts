import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {McpInstallation} from '../src/capture/mcp-installation.ts';

function fixture(){
 const home=mkdtempSync(join(tmpdir(),'agent-time-mcp-test-')),bin=join(home,'claude'),output=join(home,'capture');
 writeFileSync(bin,`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const file=path.join(process.env.CLAUDE_CONFIG_DIR||process.env.HOME,'.claude.json');
const data=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};
data.mcpServers ||= {};
const args=process.argv.slice(2),action=args[1];
if(action==='add'){
 const stop=args.indexOf('--'),env={},at=args.indexOf('-e');
 if(at>=0)for(const pair of args.slice(at+1,stop)){const i=pair.indexOf('=');env[pair.slice(0,i)]=pair.slice(i+1);}
 data.mcpServers['agent-time']={type:'stdio',command:args[stop+1],args:args.slice(stop+2),env};
}else if(action==='remove')delete data.mcpServers['agent-time'];
else process.exit(2);
fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(data));
`);chmodSync(bin,0o755);
 const manager=new McpInstallation(output,{home,env:{PATH:process.env.PATH},cli:{claude:bin},runtime:{node:process.execPath,server:join(process.cwd(),'src/mcp/server.ts')}});
 return {home,manager,close:()=>rmSync(home,{recursive:true,force:true})};
}

test('MCP setup adds and removes only its owned Claude entry',()=>{
 const f=fixture();try{
  const config=join(f.home,'.claude.json');writeFileSync(config,JSON.stringify({mcpServers:{other:{type:'stdio',command:'/bin/echo',args:[],env:{}}}}));
  assert.equal(f.manager.status().targets.find(t=>t.provider==='claude')?.state,'not-installed');
  assert.equal(f.manager.install('claude').targets.find(t=>t.provider==='claude')?.state,'installed');
  const file=JSON.parse(readFileSync(config,'utf8'));assert.equal(file.mcpServers.other.command,'/bin/echo');assert.equal(file.mcpServers['agent-time'].env.ADE_CAPTURE_OUTPUT,join(f.home,'capture'));
  assert.equal(f.manager.remove('claude').targets.find(t=>t.provider==='claude')?.state,'not-installed');
  const after=JSON.parse(readFileSync(config,'utf8'));assert.equal(after.mcpServers.other.command,'/bin/echo');assert.equal(after.mcpServers['agent-time'],undefined);
 }finally{f.close();}
});
test('MCP setup discovers an Orca Claude profile without an active config override',()=>{
 const f=fixture();try{
  const profile=join(f.home,'Library/Application Support/orca/claude-profiles/profile/home');mkdirSync(profile,{recursive:true});
  writeFileSync(join(profile,'settings.json'),'{}');
  const config=join(profile,'.claude.json');writeFileSync(config,JSON.stringify({mcpServers:{other:{type:'stdio',command:'/bin/echo',args:[],env:{}}}}));
  const target=f.manager.status().targets.find(t=>t.provider==='claude'&&t.label.includes('Orca profile'));assert.ok(target);
  f.manager.install('claude',[target.id]);
  const servers=JSON.parse(readFileSync(config,'utf8')).mcpServers;
  assert.equal(servers.other.command,'/bin/echo');assert.equal(servers['agent-time'].env.ADE_CAPTURE_OUTPUT,join(f.home,'capture'));
  assert.equal(f.manager.status().targets.find(t=>t.id===target.id)?.state,'installed');
 }finally{f.close();}
});
test('MCP setup adopts an unchanged Agent Time entry copied into an Orca Claude profile',()=>{
 const f=fixture();try{
  f.manager.install('claude');
  const user=join(f.home,'.claude.json'),profile=join(f.home,'Library/Application Support/orca/claude-profiles/profile/home');mkdirSync(profile,{recursive:true});
  writeFileSync(join(profile,'settings.json'),'{}');
  const config=join(profile,'.claude.json'),userBytes=readFileSync(user,'utf8');writeFileSync(config,userBytes);
  const target=f.manager.status().targets.find(t=>t.provider==='claude'&&t.label.includes('Orca profile'))!;
  assert.equal(target.state,'needs-update');f.manager.install('claude',[target.id]);
  assert.equal(f.manager.status().targets.find(t=>t.id===target.id)?.state,'installed');
  assert.equal(readFileSync(config,'utf8'),userBytes);
 }finally{f.close();}
});
test('an active Orca Claude profile does not hide the normal user MCP target',()=>{
 const f=fixture();try{
  const profile=join(f.home,'Library/Application Support/orca/claude-profiles/profile/home');mkdirSync(profile,{recursive:true});writeFileSync(join(profile,'settings.json'),'{}');
  const manager=new McpInstallation(join(f.home,'capture'),{home:f.home,env:{PATH:process.env.PATH,CLAUDE_CONFIG_DIR:profile},cli:{claude:join(f.home,'claude')},runtime:{node:process.execPath,server:join(process.cwd(),'src/mcp/server.ts')}});
  const claude=manager.status().targets.filter(t=>t.provider==='claude');
  assert.equal(claude.length,2);assert.ok(claude.some(t=>t.label.endsWith('user')));assert.ok(claude.some(t=>t.label.endsWith('active config')));
 }finally{f.close();}
});

test('MCP setup refuses to replace or remove an externally changed entry',()=>{
 const f=fixture();try{
  const config=join(f.home,'.claude.json');writeFileSync(config,JSON.stringify({mcpServers:{'agent-time':{type:'stdio',command:'/bin/echo',args:[],env:{}}}}));
  assert.equal(f.manager.status().targets.find(t=>t.provider==='claude')?.state,'conflict');
  assert.throws(()=>f.manager.install('claude'),/not app-managed/);
  f.manager.status();assert.throws(()=>f.manager.remove('claude'),/not app-managed/);
  assert.equal(JSON.parse(readFileSync(config,'utf8')).mcpServers['agent-time'].command,'/bin/echo');
 }finally{f.close();}
});
