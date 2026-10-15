import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WebsiteResolver,githubRemoteSlug,matchingRule,normalizeRulePattern,websiteKey,type KnownWorkspace} from '../src/capture/website-resolver.ts';

test('URL-prefix rules override origin rules and survive reopening',()=>{
 const output=mkdtempSync(join(tmpdir(),'agent-time-web-rule-')),one=join(output,'one'),two=join(output,'two');
 mkdirSync(one);mkdirSync(two);
 try{
  const resolver=new WebsiteResolver(output);
  resolver.setRule('https://github.com',one);
  resolver.setRule('https://github.com/acme/app',two);
  assert.equal(matchingRule(new URL('https://github.com/acme/app/issues/1'),resolver.rules())?.projectPath,two);
  assert.equal(matchingRule(new URL('https://github.com/acme/other'),resolver.rules())?.projectPath,one);
  assert.equal(matchingRule(new URL('https://github.com/acme/application'),resolver.rules())?.projectPath,one);
  assert.equal(websiteKey('https://github.com/acme/app/issues/1',resolver.rules()),'https://github.com/acme/app');
  assert.equal(websiteKey('https://github.com/acme/other',resolver.rules()),'https://github.com');
  assert.deepEqual(new WebsiteResolver(output).rules(),resolver.rules());
  assert.throws(()=>normalizeRulePattern('https://github.com/acme/app?token=secret'));
 }finally{rmSync(output,{recursive:true});}
});

test('a listening process in an Orca worktree resolves localhost to that project',async()=>{
 const output=mkdtempSync(join(tmpdir(),'agent-time-web-port-')),project=join(output,'project'),workspace=join(project,'.orca','workspaces','feature');
 mkdirSync(workspace,{recursive:true});
 const known:KnownWorkspace[]=[{projectPath:project,workspacePath:workspace,workspaceId:'host::'+workspace}];
 const run=async(file:string,args:string[])=>{
  if(file.endsWith('lsof')&&args.some(a=>a==='-iTCP:1420'))return 'p42\ncnode\nn127.0.0.1:1420';
  if(file.endsWith('lsof'))return `p42\nfcwd\nn${join(workspace,'app')}`;
  if(file.endsWith('ps'))return args.includes('command=')?'node vite':'1';
  return null;
 };
 mkdirSync(join(workspace,'app'));
 try{
  const result=await new WebsiteResolver(output,run).resolve('http://localhost:1420/dashboard',known);
  assert.equal(result?.projectPath,project);
  assert.equal(result?.workspaceId,'host::'+workspace);
  assert.equal(result?.source,'orca_process');
 }finally{rmSync(output,{recursive:true});}
});

test('a matching GitHub clone remote identifies repository pages, but a generic page does not',async()=>{
 const output=mkdtempSync(join(tmpdir(),'agent-time-web-git-')),project=join(output,'project');mkdirSync(project);
 const known:KnownWorkspace[]=[{projectPath:project,workspacePath:project,workspaceId:'host::'+project}];
 const run=async(file:string,args:string[])=>file.endsWith('git')&&args.includes('config')&&args.includes(project)?'remote.origin.url git@github.com:acme/app.git':null;
 try{
  assert.equal(githubRemoteSlug('git@github.com:acme/app.git'),'acme/app');
  const resolver=new WebsiteResolver(output,run);
  assert.equal((await resolver.resolve('https://github.com/acme/app/issues/1',known))?.source,'git_remote');
  assert.deepEqual(await resolver.repositoryProjects(['acme/app'],known),{'acme/app':[project]});
  assert.equal((await resolver.resolve('https://github.com/acme/other',known))?.projectPath,undefined);
 }finally{rmSync(output,{recursive:true});}
});

test('project settings list tracked projects and saved rules',()=>{
 const output=mkdtempSync(join(tmpdir(),'agent-time-web-projects-')),tracked=join(output,'tracked'),saved=join(output,'saved');mkdirSync(tracked);mkdirSync(saved);
 try{
  const resolver=new WebsiteResolver(output);
  resolver.setRule('https://example.com',saved);
  assert.deepEqual(resolver.candidateProjects([{projectPath:tracked,workspacePath:tracked,workspaceId:'host::'+tracked}]),[saved,tracked]);
 }finally{rmSync(output,{recursive:true});}
});

test('Docker bind mounts can resolve a published port; declarations and context remain suggestions',async()=>{
 const output=mkdtempSync(join(tmpdir(),'agent-time-web-docker-')),project=join(output,'project');mkdirSync(project);
 const known:KnownWorkspace[]=[{projectPath:project,workspacePath:project,workspaceId:'host::'+project}];
 const run=async(file:string,args:string[])=>{
  if(file.endsWith('lsof'))return null;
  if(file.endsWith('docker')&&args.includes('context'))return 'unix:///tmp/docker.sock';
  if(file.endsWith('docker')&&args.includes('ps'))return 'container1';
  if(file.endsWith('docker')&&args.includes('inspect'))return JSON.stringify([{NetworkSettings:{Ports:{'80/tcp':[{HostPort:'8080'}]}},Mounts:[{Type:'bind',Source:project}],Config:{Labels:{}}}]);
  return null;
 };
 try{
  const resolver=new WebsiteResolver(output,run);
  assert.equal((await resolver.resolve('http://localhost:8080',known))?.source,'docker');
  const broadMount=new WebsiteResolver(output,async(file,args)=>file.endsWith('docker')&&args.includes('context')?'unix:///tmp/docker.sock':file.endsWith('docker')&&args.includes('ps')?'container1':file.endsWith('docker')&&args.includes('inspect')?JSON.stringify([{NetworkSettings:{Ports:{'80/tcp':[{HostPort:'8080'}]}},Mounts:[{Type:'bind',Source:output}],Config:{Labels:{}}}]):null);
  assert.equal((await broadMount.resolve('http://localhost:8080',known))?.projectPath,undefined);
  const remote=new WebsiteResolver(output,async(file,args)=>file.endsWith('docker')&&args.includes('context')?'ssh://remote-host':file.endsWith('docker')&&args.includes('ps')?'container1':null);
  assert.equal((await remote.resolve('http://localhost:8080',known))?.projectPath,undefined);
  writeFileSync(join(project,'vite.config.ts'),'export default { server: { port: 5173 } }');
  const unresolved=await resolver.resolve('http://localhost:5173',known,{workspaceId:'host::'+project,observedAt:Date.now()/1000});
  assert.equal(unresolved?.projectPath,undefined);
  assert.deepEqual(new Set(unresolved?.suggestions.map(s=>s.source)),new Set(['repository_config','recent_orca']));
 }finally{rmSync(output,{recursive:true});}
});

test('a container port forwarder cannot attribute a site from its unrelated cwd',async()=>{
 const output=mkdtempSync(join(tmpdir(),'agent-time-web-forwarder-'));
 const wrong=join(output,'gemapar'),right=join(output,'ch_apptitude_kuva');
 const rightWorktree=join(right,'.orca','workspaces','phase2');
 mkdirSync(wrong);mkdirSync(rightWorktree,{recursive:true});
 const known:KnownWorkspace[]=[
  {projectPath:wrong,workspacePath:wrong,workspaceId:'host::'+wrong},
  {projectPath:right,workspacePath:rightWorktree,workspaceId:'host::'+rightWorktree},
 ];
 const run=async(file:string,args:string[])=>{
  if(file.endsWith('lsof')&&args.includes('-iTCP:14210'))return 'p78637\ncOrbStack Helper\nn127.0.0.1:14210';
  if(file.endsWith('lsof'))return `p78637\nfcwd\nn${wrong}`;
  if(file.endsWith('ps'))return args.includes('command=')?'OrbStack Helper vmgr':'1';
  if(file.endsWith('docker')&&args.includes('context'))return 'unix:///tmp/docker.sock';
  if(file.endsWith('docker')&&args.includes('ps'))return 'kuva-container';
  if(file.endsWith('docker')&&args.includes('inspect'))return JSON.stringify([{
   NetworkSettings:{Ports:{'4200/tcp':[{HostIp:'127.0.0.1',HostPort:'14210'}]}},
   Mounts:[{Type:'bind',Source:rightWorktree,Destination:'/app'}],Config:{Labels:{}},
  }]);
  return null;
 };
 try{
  const result=await new WebsiteResolver(output,run).resolve('http://localhost:14210',known);
  assert.equal(result?.projectPath,right);
  assert.equal(result?.source,'docker');
  assert.equal(result?.detail,'Docker published port and bind mount');
 }finally{rmSync(output,{recursive:true});}
});

test('a proxy worktree is not assigned until its configured upstream resolves',async()=>{
 const output=mkdtempSync(join(tmpdir(),'agent-time-web-proxy-')),project=join(output,'project');mkdirSync(project);
 writeFileSync(join(project,'Caddyfile'),'app.localhost:8080 {\n reverse_proxy localhost:5173\n}\n');
 const known:KnownWorkspace[]=[{projectPath:project,workspacePath:project,workspaceId:'host::'+project}];
 const run=async(file:string,args:string[])=>{
  if(file.endsWith('lsof')&&args.includes('-iTCP:8080'))return 'p42\nccaddy\nn127.0.0.1:8080';
  if(file.endsWith('lsof')&&args.includes('-iTCP:5173'))return 'p43\ncnode\nn127.0.0.1:5173';
  if(file.endsWith('lsof'))return `n${project}`;
  if(file.endsWith('ps'))return args.includes('ppid=')?'1':args.includes('42')?'caddy run':'node vite';
  if(file.endsWith('git'))return project;
  return null;
 };
 try{
  const match=await new WebsiteResolver(output,run).resolve('http://app.localhost:8080/',known);
  assert.equal(match?.source,'proxy_config');
  assert.equal(match?.projectPath,project);
 }finally{rmSync(output,{recursive:true});}
});
