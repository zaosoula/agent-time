import {accessSync,constants,existsSync,mkdirSync,readFileSync,readdirSync,renameSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {agentById} from './sources/agent-registry.ts';

type Provider='claude'|'codex';
type Entry={command:string;args:string[];env:Record<string,string>};
type Target={id:string;provider:Provider;label:string;home:string;configHome:string;override:boolean};
export interface McpTarget {id:string;provider:Provider;label:string;state:'not-installed'|'installed'|'needs-update'|'conflict'|'unavailable'|'error';detail:string;}
export interface McpInstallationStatus {runtimeReady:boolean;targets:McpTarget[];}
interface Options {home?:string;env?:NodeJS.ProcessEnv;cli?:Partial<Record<Provider,string>>;runtime?:{node:string;server:string};}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex').slice(0,16);
const owned=(value:unknown):value is Entry=>Boolean(value&&typeof value==='object'&&typeof (value as Entry).command==='string'&&Array.isArray((value as Entry).args)&&typeof (value as Entry).env==='object');
const same=(a:Entry,b:Entry)=>a.command===b.command&&JSON.stringify(a.args)===JSON.stringify(b.args)&&JSON.stringify(Object.entries(a.env).sort())===JSON.stringify(Object.entries(b.env).sort());

export class McpInstallation {
 private home:string;private env:NodeJS.ProcessEnv;private output:string;private options:Options;private ledger:string;private runtime:{node:string;server:string};
 constructor(output:string,options:Options={}){this.output=resolve(output);this.home=options.home||homedir();this.env=options.env||process.env;this.options=options;this.ledger=join(this.home,'Library/Application Support/studio.ezyo.agenttime/mcp-installations.json');this.runtime=options.runtime||{node:process.execPath,server:fileURLToPath(new URL('../mcp/server.ts',import.meta.url))};}
 private targets():Target[]{
  const all:Target[]=[],seen=new Set<string>();
  const add=(provider:Provider,label:string,home:string,configHome:string,override:boolean)=>{const key=provider+':'+resolve(configHome);if(seen.has(key))return;seen.add(key);all.push({id:hash(key),provider,label,home:resolve(home),configHome:resolve(configHome),override});};
  for(const provider of ['claude','codex'] as const){
   const agent=agentById.get(provider);if(!agent)continue;
   const active=this.env[agent.configEnv];add(provider,`${agent.name} · user`,this.home,provider==='claude'?this.home:join(this.home,agent.configDirectory),false);
   if(active)add(provider,`${agent.name} · active config`,this.home,active,true);
   for(const directory of agent.orcaDirectories||[provider+'-accounts']){
    const base=join(this.home,'Library/Application Support/orca',directory);let index=0;
    for(const item of existsSync(base)?readdirSync(base,{withFileTypes:true}):[]){if(!item.isDirectory())continue;index++;
     for(const folder of agent.discoverAccount(join(base,item.name)))add(provider,`${agent.name} · Orca ${directory.endsWith('-profiles')?'profile':'account'} ${index}`,folder,folder,true);
    }
   }
  }
  return all;
 }
 private environment(target:Target){const env:NodeJS.ProcessEnv={...this.env,HOME:target.home};if(target.provider==='codex')env.CODEX_HOME=target.configHome;else if(target.override)env.CLAUDE_CONFIG_DIR=target.configHome;else delete env.CLAUDE_CONFIG_DIR;return env;}
 private binary(provider:Provider){const custom=this.options.cli?.[provider];const candidates=custom?[custom]:[...new Set([...(this.env.PATH||'').split(':').filter(Boolean).map(path=>join(path,provider)),join(this.home,'.local/bin',provider),join(this.home,'.bun/bin',provider),'/opt/homebrew/bin/'+provider,'/usr/local/bin/'+provider])];for(const path of candidates){try{accessSync(path,constants.X_OK);return path;}catch{}}return null;}
 private run(target:Target,args:string[]){const bin=this.binary(target.provider);if(!bin)throw new Error(`${target.provider} CLI is not installed`);return execFileSync(bin,['mcp',...args],{encoding:'utf8',env:this.environment(target),timeout:15000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']});}
 private read(target:Target):Entry|null{
  if(target.provider==='claude'){
   const path=join(target.configHome,'.claude.json');if(!existsSync(path))return null;
   const file=JSON.parse(readFileSync(path,'utf8')) as {mcpServers?:Record<string,Entry&{type?:string}>};const entry=file.mcpServers?.['agent-time'];
   if(!entry)return null;
   if(!owned(entry)||entry.type!=='stdio'||Object.keys(entry).some(key=>!['type','command','args','env'].includes(key)))return {command:'unknown',args:[],env:{}};
   return {command:entry.command,args:entry.args,env:entry.env||{}};
  }
  if(!existsSync(join(target.configHome,'config.toml')))return null;
  try{const result=JSON.parse(this.run(target,['get','agent-time','--json'])) as {enabled?:boolean;disabled_reason?:unknown;enabled_tools?:unknown;disabled_tools?:unknown;startup_timeout_sec?:unknown;tool_timeout_sec?:unknown;transport?:{type:string;command?:string;args?:string[];env?:Record<string,string>;env_vars?:string[];cwd?:string|null}};const entry=result.transport;
   if(result.enabled===false||result.disabled_reason||result.enabled_tools||result.disabled_tools||result.startup_timeout_sec||result.tool_timeout_sec||entry?.env_vars?.length||entry?.cwd)return {command:'unknown',args:[],env:{}};
   return entry?.type==='stdio'&&entry.command?{command:entry.command,args:entry.args||[],env:entry.env||{}}:{command:'unknown',args:[],env:{}};
  }catch(error){if(String((error as {stderr?:string}).stderr||error).includes('No MCP server'))return null;throw error;}
 }
 private records():Record<string,Entry>{if(!existsSync(this.ledger))return {};const parsed:unknown=JSON.parse(readFileSync(this.ledger,'utf8'));if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('Invalid MCP installation record');return parsed as Record<string,Entry>;}
 private save(records:Record<string,Entry>){mkdirSync(dirname(this.ledger),{recursive:true,mode:0o700});const temp=this.ledger+'.'+randomUUID()+'.tmp';writeFileSync(temp,JSON.stringify(records,null,2),{mode:0o600,flag:'wx'});renameSync(temp,this.ledger);}
 private desired(provider:Provider):Entry{return {command:this.runtime.node,args:[this.runtime.server],env:{AGENT_TIME_PROVIDER:provider,ADE_CAPTURE_OUTPUT:this.output}};}
 private copiedManagedEntry(current:Entry,previous:Entry|undefined,records:Record<string,Entry>,desired:Entry){return !previous&&same(current,desired)&&Object.values(records).some(entry=>owned(entry)&&same(entry,current));}
 status():McpInstallationStatus{
  const runtimeReady=existsSync(this.runtime.node)&&existsSync(this.runtime.server);let records:Record<string,Entry>={};try{records=this.records();}catch{return {runtimeReady,targets:this.targets().map(t=>({id:t.id,provider:t.provider,label:t.label,state:'error',detail:'MCP installation record needs repair'}))};}
  return {runtimeReady,targets:this.targets().map(target=>{try{
   const current=this.read(target),previous=records[target.id],desired=this.desired(target.provider);
   if(!current)return {id:target.id,provider:target.provider,label:target.label,state:'not-installed',detail:'Agent Time tools are not configured'};
   if(this.copiedManagedEntry(current,previous,records,desired))return {id:target.id,provider:target.provider,label:target.label,state:'needs-update',detail:'Copied Agent Time tools can be linked to this configuration'};
   if(!previous||!owned(previous)||!same(current,previous))return {id:target.id,provider:target.provider,label:target.label,state:'conflict',detail:'This Agent Time entry was changed outside the app; it will not be overwritten'};
   if(!runtimeReady||!same(current,desired))return {id:target.id,provider:target.provider,label:target.label,state:'needs-update',detail:'The MCP runtime or data path needs repair'};
   return {id:target.id,provider:target.provider,label:target.label,state:'installed',detail:'Configured; start a new agent session to load tools'};
  }catch(error){return {id:target.id,provider:target.provider,label:target.label,state:this.binary(target.provider)?'error':'unavailable',detail:this.binary(target.provider)?String(error):`${target.provider} CLI is not installed`};}})};
 }
 install(provider:Provider,targetIds?:string[]):McpInstallationStatus{
  if(!agentById.has(provider))throw new Error('Unsupported MCP provider');const targets=this.targets().filter(t=>t.provider===provider);if(targetIds?.some(id=>!targets.some(t=>t.id===id)))throw new Error('Invalid MCP target');
  if(!existsSync(this.runtime.node)||!existsSync(this.runtime.server))throw new Error('Bundled MCP runtime is unavailable');
  const records=this.records(),selected=targets.filter(t=>!targetIds||targetIds.includes(t.id));
  for(const target of selected){
   const current=this.read(target),previous=records[target.id],desired=this.desired(provider);
   if(current&&!this.copiedManagedEntry(current,previous,records,desired)&&(!previous||!owned(previous)||!same(current,previous)))throw new Error(`${target.label}: existing Agent Time MCP entry is not app-managed`);
   if(!this.binary(provider))throw new Error(`${target.label}: ${provider} CLI is not installed`);
  }
  for(const target of selected){
   const current=this.read(target),previous=records[target.id],desired=this.desired(provider);
   if(current&&same(current,desired)){if(this.copiedManagedEntry(current,previous,records,desired)){records[target.id]=desired;this.save(records);}continue;}
   // CLI removal is needed before re-adding a managed entry on both providers.
   if(current)this.run(target,['remove','agent-time']);
   try{this.run(target,provider==='claude'?['add','--scope','user','agent-time','-e',`AGENT_TIME_PROVIDER=${provider}`,`ADE_CAPTURE_OUTPUT=${this.output}`,'--',desired.command,...desired.args]:['add','--env',`AGENT_TIME_PROVIDER=${provider}`,'--env',`ADE_CAPTURE_OUTPUT=${this.output}`,'agent-time','--',desired.command,...desired.args]);}
   catch(error){if(current&&previous){try{this.addPrevious(target,previous);}catch{/* Keep original error; status will show the broken entry. */}}throw error;}
   records[target.id]=desired;this.save(records);
  }
  return this.status();
 }
 private addPrevious(target:Target,entry:Entry){const variables=Object.entries(entry.env);this.run(target,target.provider==='claude'?['add','--scope','user','agent-time',...(variables.length?['-e',...variables.map(([k,v])=>k+'='+v)]:[]),'--',entry.command,...entry.args]:['add',...variables.flatMap(([k,v])=>['--env',k+'='+v]),'agent-time','--',entry.command,...entry.args]);}
 remove(provider:Provider,targetIds?:string[]):McpInstallationStatus{
  if(!agentById.has(provider))throw new Error('Unsupported MCP provider');const targets=this.targets().filter(t=>t.provider===provider);if(targetIds?.some(id=>!targets.some(t=>t.id===id)))throw new Error('Invalid MCP target');const records=this.records();
  for(const target of targets.filter(t=>!targetIds||targetIds.includes(t.id))){const current=this.read(target),previous=records[target.id];if(!current)continue;if(!previous||!owned(previous)||!same(current,previous))throw new Error(`${target.label}: existing Agent Time MCP entry is not app-managed`);this.run(target,['remove','agent-time']);delete records[target.id];this.save(records);}
  return this.status();
 }
}
