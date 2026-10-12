import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export interface CaptureEvent {
  eventId: string; source: string; kind: string; observedAt: number; monotonicAt: number; collectorEpoch: string;
  sourceAt?: number; hostId?: string; runtimeId?: string; workspaceId?: string; cwd?: string;
  terminalHandle?: string; terminalIncarnation?: string; provider?: string; sessionId?: string;
  turnId?: string; agentId?: string; parentAgentId?: string; runId?: string; taskId?: string; dispatchId?: string;
  data?: Record<string, unknown>;
}
export interface Interval {
  start: number; end: number; state: 'running' | 'waiting' | 'human'; proof: 'observed' | 'inferred';
  sourceEventIds: string[]; workspaceId?: string; sessionId?: string; agentId?: string;
  provider?: string; runId?: string; taskId?: string; dispatchId?: string; child?: boolean;
}
export interface Issue { reason: string; eventId?: string; source?: string; }
export interface Session {
  key: string; workspaceId?: string; cwd?: string; runId?: string; taskId?: string; dispatchId?: string;
  sessionId?: string; agentId?: string; provider?: string; title: string; state: string;
  terminalHandle?: string; lastObservedAt: number; seconds: number; child: boolean; proof: string;
}
export interface Summary {
  intervals: Interval[]; unresolved: Issue[]; coverage: Issue[]; sessions: Session[];
  humanSeconds: number; agentSeconds: number; elapsedSeconds: number; childAgentSeconds: number;
}
export interface Verdict { scenario: string; mode: 'live' | 'simulated'; status: 'pass' | 'fail' | 'unsupported' | 'unverified'; evidence: string; }
const epoch = randomUUID();
export function makeEvent(source: string, kind: string, fields: Partial<CaptureEvent> = {}): CaptureEvent {
  const event = { eventId: randomUUID(), source, kind, observedAt: Date.now()/1000,
    monotonicAt: performance.now()/1000, collectorEpoch: epoch, ...fields };
  validateEvent(event); return event;
}
export function validateEvent(event: CaptureEvent): void {
  for (const key of ['eventId','source','kind','collectorEpoch'] as const)
    if (typeof event[key] !== 'string' || !event[key]) throw new Error(`invalid ${key}`);
  for (const key of ['observedAt','monotonicAt'] as const)
    if (!Number.isFinite(event[key])) throw new Error(`invalid ${key}`);
  if (event.sourceAt !== undefined && !Number.isFinite(event.sourceAt)) throw new Error('invalid sourceAt');
}
