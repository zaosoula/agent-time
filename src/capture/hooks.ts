import { mkdirSync, writeFileSync, renameSync, readdirSync, readFileSync, unlinkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateEvent, type CaptureEvent, type Issue } from './events.ts';
import { EventStore } from './store.ts';
import {agentById} from './sources/agent-registry.ts';
export function normalizeHook(provider: string, payload: unknown, context: Partial<CaptureEvent>): CaptureEvent {
  const agent=agentById.get(provider);
  if(!agent)throw new Error('Unsupported hook provider');
  return agent.normalizeHook(payload,context);
}
export function hookContext(): Partial<CaptureEvent> {
  // Only allowlisted identifiers; never capture the environment or hook endpoint credentials.
  return { terminalHandle: process.env.ORCA_TERMINAL_HANDLE,
    workspaceId: process.env.ORCA_WORKTREE_ID || process.env.ORCA_WORKSPACE_ID,
    hostId: process.env.ORCA_EXECUTION_HOST_ID || 'local' };
}
export function spoolHook(event: CaptureEvent, directory: string): boolean {
  try {
    mkdirSync(directory,{recursive:true,mode:0o700});
    const folder=lstatSync(directory);if(!folder.isDirectory()||folder.isSymbolicLink())return false;
    const path=join(directory,randomUUID());
    writeFileSync(path+'.tmp',JSON.stringify(event),{mode:0o600,flag:'wx'});renameSync(path+'.tmp',path+'.json'); return true;
  } catch { return false; }
}
export interface SpoolStatus {pending:number;temporary:number;invalid:number;oldestAgeSeconds:number|null;truncated:boolean;}
export function spoolStatus(directory:string,now=Date.now()/1000):SpoolStatus{
 const status:SpoolStatus={pending:0,temporary:0,invalid:0,oldestAgeSeconds:null,truncated:false};
 try{const folder=lstatSync(directory);if(!folder.isDirectory()||folder.isSymbolicLink()){status.invalid=1;return status;}}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return status;throw error;}
 let files:string[];
 try{files=readdirSync(directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return status;throw error;}
 for(const file of files.slice(0,100_000)){
  if(!file.endsWith('.json')&&!file.endsWith('.tmp'))continue;
  let info;
  try{info=lstatSync(join(directory,file));}catch{status.invalid++;continue;}
  if(!info.isFile()||info.isSymbolicLink()||info.size>262144){status.invalid++;continue;}
  if(file.endsWith('.tmp')){status.temporary++;continue;}
  status.pending++;
  const age=Math.max(0,Math.floor(now-info.mtimeMs/1000));
  status.oldestAgeSeconds=Math.max(status.oldestAgeSeconds||0,age);
 }
 status.truncated=files.length>100_000;
 return status;
}
export function importSpool(directory: string, store: EventStore, accept:(event:CaptureEvent)=>boolean=()=>true): Issue[] {
  const issues: Issue[]=[];mkdirSync(directory,{recursive:true,mode:0o700});
  const folder=lstatSync(directory);if(!folder.isDirectory()||folder.isSymbolicLink())throw new Error('Invalid hook spool directory');
  for(const file of readdirSync(directory).filter(f=>f.endsWith('.json')).sort()) {
    const path=join(directory,file);
    let event:CaptureEvent|undefined;
    try {
      const info=lstatSync(path);if(!info.isFile() || info.isSymbolicLink() || info.size>262144) throw new Error('invalid spool file');
      event=JSON.parse(readFileSync(path,'utf8')) as CaptureEvent;validateEvent(event);
    } catch { issues.push({reason:`Unreadable event record: ${file}`,source:'hook'}); }
    if(!event)continue;
    if(accept(event))store.put(event);
    unlinkSync(path);
  }
  return issues;
}
