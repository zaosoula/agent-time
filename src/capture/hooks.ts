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
    const path=join(directory,randomUUID());
    writeFileSync(path+'.tmp',JSON.stringify(event),{mode:0o600,flag:'wx'});renameSync(path+'.tmp',path+'.json'); return true;
  } catch { return false; }
}
export function importSpool(directory: string, store: EventStore, accept:(event:CaptureEvent)=>boolean=()=>true): Issue[] {
  const issues: Issue[]=[];mkdirSync(directory,{recursive:true,mode:0o700});
  for(const file of readdirSync(directory).filter(f=>f.endsWith('.json')).sort()) {
    const path=join(directory,file);
    try {
      const info=lstatSync(path);if(!info.isFile() || info.isSymbolicLink() || info.size>262144) throw new Error('invalid spool file');
      const event=JSON.parse(readFileSync(path,'utf8')) as CaptureEvent;validateEvent(event);if(accept(event))store.put(event);unlinkSync(path);
    } catch { issues.push({reason:`Unreadable event record: ${file}`,source:'hook'}); }
  }
  return issues;
}
