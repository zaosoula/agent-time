import {createHash,randomUUID} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {agentById} from './sources/agent-registry.ts';

type StatusLine={type:'command';command:string;refreshInterval?:number;[key:string]:unknown};
type RecordEntry={previous:StatusLine|null;installed:StatusLine};
type Target={id:string;label:string;path:string};
export interface ClaudeStatusLineTarget {id:string;label:string;state:'not-installed'|'installed'|'needs-update'|'conflict'|'error';detail:string;}
export interface ClaudeStatusLineStatus {runtimeReady:boolean;targets:ClaudeStatusLineTarget[];}
interface Options {home?:string;env?:NodeJS.ProcessEnv;runtime?:{node:string;script:string};}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex').slice(0,16);
const quote=(value:string)=>`'${value.replaceAll("'","'\\''")}'`;
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);

export class ClaudeStatusLineInstallation {
 private output:string;private home:string;private env:NodeJS.ProcessEnv;private runtime:{node:string;script:string};private ledger:string;
 constructor(output:string,options:Options={}){
  this.output=resolve(output);this.home=options.home||homedir();this.env=options.env||process.env;
  this.runtime=options.runtime||{node:process.execPath,script:fileURLToPath(new URL('../mcp/claude-statusline-cli.ts',import.meta.url))};
  this.ledger=join(this.output,'claude-statusline-installations.json');
 }
 private targets():Target[]{
  const items:Target[]=[],seen=new Set<string>();
  const add=(label:string,folder:string)=>{const path=resolve(join(folder,'settings.json'));if(seen.has(path))return;seen.add(path);items.push({id:hash(path),label,path});};
  add('Claude Code · user',join(this.home,'.claude'));
  if(this.env.CLAUDE_CONFIG_DIR)add('Claude Code · active config',this.env.CLAUDE_CONFIG_DIR);
  const source=agentById.get('claude');
  for(const directory of source?.orcaDirectories||[]){const base=join(this.home,'Library/Application Support/orca',directory);let index=0;
   for(const entry of existsSync(base)?readdirSync(base,{withFileTypes:true}):[]){if(!entry.isDirectory())continue;index++;
    for(const folder of source!.discoverAccount(join(base,entry.name)))add(`Claude Code · Orca ${directory.endsWith('-profiles')?'profile':'account'} ${index}`,folder);
   }
  }
  return items;
 }
 private records():Record<string,RecordEntry>{if(!existsSync(this.ledger))return {};const value:unknown=JSON.parse(readFileSync(this.ledger,'utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid status line installation record');return value as Record<string,RecordEntry>;}
 private write(path:string,value:string,expected:string|null,mode=0o600){
  mkdirSync(dirname(path),{recursive:true,mode:0o700});const temp=path+'.'+randomUUID()+'.tmp';
  writeFileSync(temp,value,{mode,flag:'wx'});
  try{const current=existsSync(path)?readFileSync(path,'utf8'):null;if(current!==expected)throw new Error('Claude settings changed while installing; retry');renameSync(temp,path);}
  finally{if(existsSync(temp))rmSync(temp);}
 }
 private config(target:Target):{raw:string|null;value:Record<string,unknown>;line:StatusLine|null;mode:number}{
  if(!existsSync(target.path))return {raw:null,value:{},line:null,mode:0o600};
  const info=lstatSync(target.path);if(!info.isFile()||info.isSymbolicLink())throw new Error('Claude settings must be a regular file');
  const raw=readFileSync(target.path,'utf8'),value=JSON.parse(raw) as Record<string,unknown>;
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid Claude settings');
  const line=value.statusLine;
  if(line!==undefined&&(!line||typeof line!=='object'||Array.isArray(line)||(line as StatusLine).type!=='command'||typeof (line as StatusLine).command!=='string'))throw new Error('Unsupported Claude status line configuration');
  return {raw,value,line:line as StatusLine||null,mode:info.mode&0o777};
 }
 private desired(target:Target,previous:StatusLine|null):StatusLine{return {...(previous||{}),type:'command',command:[this.runtime.node,this.runtime.script,this.output,this.ledger,target.id].map(quote).join(' '),refreshInterval:30};}
 status():ClaudeStatusLineStatus{
  const runtimeReady=existsSync(this.runtime.node)&&existsSync(this.runtime.script);let records:Record<string,RecordEntry>={};
  try{records=this.records();}catch{return {runtimeReady,targets:this.targets().map(target=>({id:target.id,label:target.label,state:'error',detail:'Status line installation record needs repair'}))};}
  return {runtimeReady,targets:this.targets().map(target=>{try{
   const current=this.config(target).line,record=records[target.id];
   if(!record)return {id:target.id,label:target.label,state:'not-installed',detail:current?'Existing status line will be kept':'No status line configured'};
   if(!equal(current,record.installed))return {id:target.id,label:target.label,state:'conflict',detail:'Status line changed outside Agent Time; it will not be overwritten'};
   if(!runtimeReady||!equal(current,this.desired(target,record.previous)))return {id:target.id,label:target.label,state:'needs-update',detail:'Agent Time status line runtime needs repair'};
   return {id:target.id,label:target.label,state:'installed',detail:'Current task appears when this Claude session reports one'};
  }catch(error){return {id:target.id,label:target.label,state:'error',detail:String(error)};}})};
 }
 install(id:string):ClaudeStatusLineStatus{
  const target=this.targets().find(item=>item.id===id);if(!target)throw new Error('Unknown Claude status line target');
  if(!existsSync(this.runtime.node)||!existsSync(this.runtime.script))throw new Error('Bundled status line runtime is unavailable');
  const records=this.records(),config=this.config(target),record=records[id];
  if(record&&!equal(config.line,record.installed))throw new Error('Claude status line changed outside Agent Time');
  const previous=record?record.previous:config.line,desired=this.desired(target,previous);
  if(equal(config.line,desired))return this.status();
  const next={...config.value,statusLine:desired};this.write(target.path,JSON.stringify(next,null,2)+'\n',config.raw,config.mode);
  try{records[id]={previous,installed:desired};const before=existsSync(this.ledger)?readFileSync(this.ledger,'utf8'):null;this.write(this.ledger,JSON.stringify(records,null,2)+'\n',before);}
  catch(error){const current=readFileSync(target.path,'utf8');this.write(target.path,config.raw||'{}\n',current,config.mode);throw error;}
  return this.status();
 }
 remove(id:string):ClaudeStatusLineStatus{
  const target=this.targets().find(item=>item.id===id);if(!target)throw new Error('Unknown Claude status line target');
  const records=this.records(),record=records[id];if(!record)return this.status();
  const config=this.config(target);if(!equal(config.line,record.installed))throw new Error('Claude status line changed outside Agent Time');
  const next={...config.value};if(record.previous)next.statusLine=record.previous;else delete next.statusLine;
  this.write(target.path,JSON.stringify(next,null,2)+'\n',config.raw,config.mode);
  delete records[id];const before=readFileSync(this.ledger,'utf8');this.write(this.ledger,JSON.stringify(records,null,2)+'\n',before);
  return this.status();
 }
}
