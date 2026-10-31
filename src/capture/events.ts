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
  start: number; end: number; state: 'running' | 'turn' | 'grouped' | 'waiting' | 'human'; proof: 'observed' | 'inferred';
  sourceEventIds: string[]; hostId?: string; workspaceId?: string; sessionId?: string; agentId?: string;
  provider?: string; runId?: string; taskId?: string; dispatchId?: string; child?: boolean;
  tabId?: string; terminalHandle?: string; tabTitle?: string; browserDomain?: string; browserOrigin?: string; browserBundleId?: string; browserUrl?: string; browserTitle?: string;
  foregroundName?: string; foregroundBundleId?: string; userAttribution?: 'assigned' | 'unassigned'; reviewSegment?: 'before' | 'after';
  attributionSource?:string;attributionReason?:string;
}
export interface Issue { reason: string; eventId?: string; source?: string; observedAt?: number; }
export interface Session {
  key: string; hostId?: string; workspaceId?: string; cwd?: string; runId?: string; taskId?: string; dispatchId?: string;
  sessionId?: string; agentId?: string; provider?: string; title: string; state: string;
  terminalHandle?: string; lastObservedAt: number; seconds: number; observedSeconds: number; child: boolean; proof: string;
}
export interface Summary {
  intervals: Interval[]; unresolved: Issue[]; coverage: Issue[]; sessions: Session[];
  humanSeconds: number; agentSeconds: number; elapsedSeconds: number; childAgentSeconds: number;
  issueReasons?: string[];
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
