import { mkdirSync, writeFileSync, renameSync, readdirSync, readFileSync, unlinkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeEvent, validateEvent, type CaptureEvent, type Issue } from './events.ts';
import { EventStore } from './store.ts';
import { object } from './orca.ts';
const kinds: Record<string,string> = {
  SessionStart:'session_start', SessionEnd:'session_end', UserPromptSubmit:'prompt_submitted',
  PreToolUse:'tool_start', PostToolUse:'tool_end', PostToolUseFailure:'tool_end',
  Stop:'response_stop', StopFailure:'interrupted', Interrupt:'interrupted',
  SubagentStart:'child_start', SubagentStop:'child_stop', PermissionRequest:'waiting',
};
export function normalizeHook(provider: string, payload: unknown, context: Partial<CaptureEvent>): CaptureEvent {
  const p=object(payload); const name=String(p.hook_event_name || 'unknown');
  const text = (value: unknown) => typeof value === 'string' ? value.slice(0,512) : undefined;
  return makeEvent('hook', kinds[name] || 'unknown',{
    ...context, provider, sessionId:text(p.session_id), turnId:text(p.turn_id), agentId:text(p.agent_id),
    cwd:text(p.cwd) || context.cwd,
    data: { hook: name, toolId: text(p.tool_use_id), toolName: text(p.tool_name),
      source: text(p.source), childType: text(p.agent_type), stopBlocked: p.stop_hook_active === true },
  });
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
