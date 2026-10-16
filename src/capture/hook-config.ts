import { existsSync, readFileSync, writeFileSync, mkdirSync, lstatSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { object } from './orca.ts';
import {agentById} from './sources/agent-registry.ts';
export interface Manifest { path: string; existed: boolean; original: string; updated: string; entries: Record<string,unknown>; }
function read(path:string):string { if(existsSync(path) && lstatSync(path).isSymbolicLink())throw new Error('symlink configuration refused');return existsSync(path)?readFileSync(path,'utf8'):''; }
function write(path:string,text:string):void { mkdirSync(dirname(path),{recursive:true,mode:0o700});const tmp=path+'.'+randomUUID()+'.tmp';writeFileSync(tmp,text,{mode:0o600,flag:'wx'});renameSync(tmp,path); }
export function prepareConfig(path:string, provider:string, command:string, events:string[], ownedCommands:string[]=[]):Manifest {
  if(!agentById.has(provider))throw new Error('unsupported provider');
  const original=read(path), config=original?JSON.parse(original):{};
  if(!config || typeof config!=='object' || Array.isArray(config))throw new Error('unsupported configuration');
  if(config.hooks !== undefined && (typeof config.hooks!=='object'||Array.isArray(config.hooks)||config.hooks===null)) throw new Error('unsupported hook configuration');
  config.hooks ||= {};
  // Remove only our recorded command handlers, including handlers in shared groups.
  for(const event of Object.keys(config.hooks)) {
    if(!Array.isArray(config.hooks[event]))throw new Error('unsupported matcher layout');
    config.hooks[event]=config.hooks[event].flatMap((group:any)=>{
      if(!group||!Array.isArray(group.hooks))throw new Error('unsupported hook group');
      const hooks=group.hooks.filter((handler:any)=>!ownedCommands.includes(handler?.command));
      return hooks.length?[{...group,hooks}]:[];
    });
    if(!config.hooks[event].length)delete config.hooks[event];
  }
  const entries:Record<string,unknown>={};
  for(const event of events) {
    if(config.hooks[event]!==undefined && !Array.isArray(config.hooks[event]))throw new Error('unsupported matcher layout');
    const entry={hooks:[{type:'command',command,timeout:2,statusMessage:`Agent Time: ${event}`}]};entries[event]=entry;
    config.hooks[event]=[...(config.hooks[event]||[]),entry];
  }
  return {path,existed:existsSync(path),original,updated:JSON.stringify(config,null,2)+'\n',entries};
}
export function applyConfig(manifest:Manifest):void {
  if(read(manifest.path)!==manifest.original)throw new Error('configuration changed before install');
  if(manifest.original===manifest.updated)return;
  write(manifest.path,manifest.updated);
}
export function restoreConfig(manifest:Manifest):void {
  const current=read(manifest.path);
  if(current===manifest.updated){if(manifest.existed)write(manifest.path,manifest.original);else unlinkSync(manifest.path);return;}
  const config=object(JSON.parse(current));
  for(const [event,entry] of Object.entries(manifest.entries)) {
    const entries=config.hooks?.[event];if(!Array.isArray(entries))throw new Error('owned hook changed; manual restoration needed');
    const index=entries.findIndex(x=>JSON.stringify(x)===JSON.stringify(entry));if(index<0)throw new Error('owned hook changed; manual restoration needed');
    entries.splice(index,1);if(!entries.length)delete config.hooks[event];
  }
  if(!Object.keys(config.hooks).length && !object(JSON.parse(manifest.original||'{}')).hooks)delete config.hooks;
  write(manifest.path,JSON.stringify(config,null,2)+'\n');
}

export function hookEvents(provider:string):string[]{
 const agent=agentById.get(provider);if(!agent)throw new Error('unsupported provider');return [...agent.hookEvents];
}
