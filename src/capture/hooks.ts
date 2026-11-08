import { mkdirSync, writeFileSync, renameSync, readdirSync, readFileSync, unlinkSync, lstatSync,existsSync,opendirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { validateEvent, type CaptureEvent, type Issue } from './events.ts';
import type { EventStore } from './store.ts';
import {agentById} from './sources/agent-registry.ts';
export function normalizeHook(provider: string, payload: unknown, context: Partial<CaptureEvent>): CaptureEvent {
  const agent=agentById.get(provider);
  if(!agent)throw new Error('Unsupported hook provider');
  return agent.normalizeHook(payload,context);
}
/** Where each agent keeps session transcripts inside its config folder. */
const transcriptFolders:Record<string,string>={claude:'/projects/',codex:'/sessions/'};
/**
 * The hook installation an event came from: a hash of the agent config file
 * that ran it, the same ID the installer gives that file. Hook commands no
 * longer carry it, so Orca copying a config between accounts cannot make it
 * stale. The transcript path names the config folder even where the agent
 * does not pass its config variable to hooks; otherwise use that variable or
 * the default folder.
 */
export function hookInstallationId(provider:string,payload:unknown,env:NodeJS.ProcessEnv=process.env,home=homedir()):string|undefined{
  const agent=agentById.get(provider);if(!agent)return undefined;
  const transcript=payload&&typeof payload==='object'?(payload as Record<string,unknown>).transcript_path:undefined;
  const marker=transcriptFolders[provider],at=typeof transcript==='string'&&marker?transcript.lastIndexOf(marker):-1;
  const folder=at>0?(transcript as string).slice(0,at):env[agent.configEnv]||join(home,agent.configDirectory);
  return createHash('sha256').update(join(resolve(folder),agent.configFile)).digest('hex').slice(0,16);
}
export function hookContext(): Partial<CaptureEvent> {
  // Only allowlisted identifiers; never capture the environment or hook endpoint credentials.
  return { terminalHandle: process.env.ORCA_TERMINAL_HANDLE,
    workspaceId: process.env.ORCA_WORKTREE_ID || process.env.ORCA_WORKSPACE_ID,
    hostId: process.env.ORCA_EXECUTION_HOST_ID || 'local' };
}
export const MAX_HOOK_BYTES=64*1024;
export const MAX_PENDING_HOOKS=4096;
const overflowName='.overflow';
export function boundedSpoolListing(directory:string,maxEntries=10000):{files:string[];truncated:boolean}{
 const files:string[]=[],dir=opendirSync(directory);let visited=0,truncated=false;
 try{let entry;while((entry=dir.readSync())){if(++visited>maxEntries){truncated=true;break;}files.push(entry.name);}}finally{dir.closeSync();}return {files,truncated};
}
function markOverflow(directory:string){try{writeFileSync(join(directory,overflowName),'Hook queue limit reached; some observations were not captured.\n',{flag:'wx',mode:0o600});}catch{/* A fixed marker already exists. */}}
export function acknowledgeSpoolOverflow(directory:string){try{unlinkSync(join(directory,overflowName));}catch{/* No marker. */}}
export function spoolHook(event: CaptureEvent, directory: string): boolean {
  try {
    mkdirSync(directory,{recursive:true,mode:0o700});
    const folder=lstatSync(directory);if(!folder.isDirectory()||folder.isSymbolicLink())return false;
    if(existsSync(join(directory,'..','storage-paused.json')))return false;
    const payload=JSON.stringify(event),listing=boundedSpoolListing(directory,MAX_PENDING_HOOKS+16);
    if(Buffer.byteLength(payload)>MAX_HOOK_BYTES||listing.truncated||listing.files.filter(file=>file.endsWith('.json')||file.endsWith('.tmp')).length>=MAX_PENDING_HOOKS){markOverflow(directory);return false;}
    const path=join(directory,randomUUID());
    writeFileSync(path+'.tmp',payload,{mode:0o600,flag:'wx'});renameSync(path+'.tmp',path+'.json'); return true;
  } catch { return false; }
}
export interface SpoolStatus {pending:number;temporary:number;invalid:number;oldestAgeSeconds:number|null;truncated:boolean;}
export function spoolStatus(directory:string,now=Date.now()/1000):SpoolStatus{
 const status:SpoolStatus={pending:0,temporary:0,invalid:0,oldestAgeSeconds:null,truncated:false};
 try{const folder=lstatSync(directory);if(!folder.isDirectory()||folder.isSymbolicLink()){status.invalid=1;return status;}}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return status;throw error;}
 let files:string[];
 try{const listing=boundedSpoolListing(directory);files=listing.files;status.truncated=listing.truncated;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return status;throw error;}
 for(const file of files){
  if(!file.endsWith('.json')&&!file.endsWith('.tmp'))continue;
  let info;
  try{info=lstatSync(join(directory,file));}catch{status.invalid++;continue;}
  if(!info.isFile()||info.isSymbolicLink()||info.size>262144){status.invalid++;continue;}
  if(file.endsWith('.tmp')){status.temporary++;continue;}
  status.pending++;
  const age=Math.max(0,Math.floor(now-info.mtimeMs/1000));
  status.oldestAgeSeconds=Math.max(status.oldestAgeSeconds||0,age);
 }

 return status;
}
export const spoolImportLimit=2000;
const orphanTemporaryAgeSeconds=3600;
const maxRejectedFiles=500;
function rejectSpoolFile(directory:string,file:string):void{
  // Keep a bounded copy for diagnosis, but never re-read a bad record every tick.
  const path=join(directory,file),rejected=join(directory,'rejected');
  try{
    mkdirSync(rejected,{recursive:true,mode:0o700});
    const folder=lstatSync(rejected);
    if(folder.isDirectory()&&!folder.isSymbolicLink()&&readdirSync(rejected).length<maxRejectedFiles){renameSync(path,join(rejected,file));return;}
  }catch{/* Fall back to removal below. */}
  try{unlinkSync(path);}catch{/* A vanished file needs no further work. */}
}
function removeOrphanTemporaries(directory:string,files:string[],now:number):void{
  for(const file of files){
    if(!file.endsWith('.tmp'))continue;
    try{const info=lstatSync(join(directory,file));if(info.isFile()&&now-info.mtimeMs/1000>orphanTemporaryAgeSeconds)unlinkSync(join(directory,file));}
    catch{/* A writer may have just renamed it. */}
  }
}
export function importSpool(directory: string, store: EventStore, accept:(event:CaptureEvent)=>boolean=()=>true, limit=spoolImportLimit): Issue[] {
  const issues: Issue[]=[];mkdirSync(directory,{recursive:true,mode:0o700});
  const folder=lstatSync(directory);if(!folder.isDirectory()||folder.isSymbolicLink())throw new Error('Invalid hook spool directory');
  const bounded=boundedSpoolListing(directory);const listing=bounded.files;
  if(existsSync(join(directory,overflowName)))issues.push({reason:'Hook queue overflow: the size or pending event limit was reached; missing observations are unverified',source:'hook'});
  if(bounded.truncated)issues.push({reason:'Hook queue listing reached its safety limit; queued events will drain in batches',source:'hook'});
  removeOrphanTemporaries(directory,listing,Date.now()/1000);
  // Bound each tick; a backlog drains over the following ticks.
  const files=listing.filter(f=>f.endsWith('.json')).sort().slice(0,limit);
  const parsed:Array<{file:string;event:CaptureEvent}>=[];
  for(const file of files){
    const path=join(directory,file);
    try{
      const info=lstatSync(path);if(!info.isFile() || info.isSymbolicLink() || info.size>262144) throw new Error('invalid spool file');
      const event=JSON.parse(readFileSync(path,'utf8')) as CaptureEvent;validateEvent(event);
      parsed.push({file,event});
    }catch(error){
      if((error as NodeJS.ErrnoException).code==='ENOENT')continue;
      issues.push({reason:`Unreadable event record: ${file}`,source:'hook'});
      rejectSpoolFile(directory,file);
    }
  }
  if(!parsed.length)return issues;
  const done:string[]=[],rejected:string[]=[];let failure:unknown;
  // One commit for the batch; a bad record cannot block the rest.
  store.transaction(()=>{
    for(const {file,event} of parsed){
      try{if(accept(event))store.put(event);done.push(file);}
      catch(error){
        if(error instanceof Error&&error.message==='event ID conflict'){issues.push({reason:`Conflicting event record: ${file}`,source:'hook'});rejected.push(file);continue;}
        failure=error;break;
      }
    }
  });
  for(const file of done)try{unlinkSync(join(directory,file));}catch{/* Already removed. */}
  for(const file of rejected)rejectSpoolFile(directory,file);
  // Storage failures keep the remaining records queued and surface to capture status.
  if(failure!==undefined)throw failure;
  return issues;
}
