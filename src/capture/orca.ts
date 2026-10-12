import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { makeEvent, type CaptureEvent, type Issue } from './events.ts';
const exec = promisify(execFile);
export type JsonObject = Record<string, any>;
export function object(value: unknown): JsonObject { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}; }
export async function callOrca(argv: string[]): Promise<unknown> {
  const command = process.env.ORCA_CLI_COMMAND || 'orca';
  const { stdout } = await exec(command, argv, { timeout: 12000, maxBuffer: 8*1024*1024 });
  return JSON.parse(stdout);
}
export async function readWorkers(call: (argv: string[]) => Promise<unknown> = callOrca, runId?: string): Promise<{ workers: JsonObject[]; coverage: Issue[] }> {
  const workers: JsonObject[] = [], coverage: Issue[] = [], seen = new Set<string>(); let cursor: string | undefined;
  try {
    do {
      const argv = ['orchestration','worker-list','--limit','100','--json'];
      if (runId) argv.push('--run',runId); if (cursor) argv.push('--cursor',cursor);
      const receipt = object(await call(argv)); if (!receipt.ok) throw new Error('Orca worker read failed');
      const r = object(receipt.result);
      if (!Array.isArray(r.workers)) throw new Error('invalid worker receipt');
      workers.push(...r.workers.map(object));
      const scope = object(r.hostScope || r.scope);
      for (const host of scope.omittedHostIds || []) coverage.push({ reason: `Host not covered: ${host}`, source: 'orca' });
      if (!r.page?.hasMore) break;
      cursor = r.page.nextCursor;
      if (typeof cursor !== 'string' || !cursor || seen.has(cursor)) throw new Error('missing or repeated pagination cursor');
      seen.add(cursor);
    } while (true);
  } catch (error) { coverage.push({ reason: String(error), source: 'orca' }); }
  return { workers, coverage };
}
export function workerEvent(worker: JsonObject): CaptureEvent {
  const p = object(worker.projection), resource = object(worker.resource), stage = object(p.stage), evidence = object(p.evidence);
  return makeEvent('orca','worker',{
    hostId: p.host?.id, workspaceId: p.workspace?.id || resource.worktreeId,
    terminalHandle: worker.agentTerminalHandle || resource.terminalHandle,
    terminalIncarnation: resource.endpointIncarnation, runtimeId: resource.endpointId,
    provider: p.provider?.id, runId: worker.runId, taskId: worker.taskId, dispatchId: worker.dispatchId,
    data: { state: stage.activity || 'unknown', outcome: p.outcome || worker.dispatchStatus,
      fresh: evidence.liveStatus === 'fresh', terminalState: worker.terminalState,
      takeover: resource.retainedReason === 'user_takeover', parent: p.parent || null,
      liveness: p.liveness?.verdict || 'unverifiable' },
  });
}
export async function terminalEvents(call = callOrca): Promise<CaptureEvent[]> {
  const receipt = object(await call(['terminal','list','--limit','1000','--json']));
  if (!receipt.ok || !Array.isArray(receipt.result?.terminals)) throw new Error('Orca terminal metadata unavailable');
  const result: CaptureEvent[] = receipt.result.terminals.filter((t: JsonObject) => t.agentIdentity).map((t: JsonObject) => makeEvent('orca','terminal',{
    hostId: t.executionHostId, runtimeId: receipt._meta?.runtimeId, workspaceId: t.worktreeId,
    cwd: t.worktreePath, terminalHandle: t.handle, terminalIncarnation: t.incarnationId,
    provider: t.agentIdentity, data: { title: String(t.title || '').slice(0,180), connected: t.connected },
  }));
  if (receipt.result.truncated) result.push(makeEvent('orca','coverage',{data:{reason:'Terminal list truncated'}}));
  for (const host of receipt.result.hostScope?.omittedHostIds || []) result.push(makeEvent('orca','coverage',{data:{reason:`Host not covered: ${host}`}}));
  return result;
}
