import type { Interval, Session } from '../capture/events.ts';
import {agentSessionKey} from '../capture/session-identity.ts';

// These identities mirror the session matching rules used by the timesheet:
// children use provider session + agent, roots prefer Dispatch, and roots
// without Dispatch use the provider session. Do not add cwd to these keys.
export function sessionIntervalKey(
  session: Pick<Session, 'child' | 'dispatchId' | 'sessionId' | 'agentId' | 'hostId' | 'provider'>,
): string {
  return agentSessionKey(session);
}

export function intervalSessionKey(
  interval: Pick<Interval, 'child' | 'dispatchId' | 'sessionId' | 'agentId' | 'hostId' | 'provider'>,
): string {
  return agentSessionKey(interval);
}

export function indexSessionIntervals(intervals: Interval[]): {
  grouped: Map<string, Interval[]>;
  running: Map<string, Interval[]>;
} {
  const grouped = new Map<string, Interval[]>(),
    running = new Map<string, Interval[]>();
  for (const interval of intervals) {
    const target = interval.state === 'grouped' ? grouped : interval.state === 'running' ? running : null;
    if (!target) continue;
    const key = intervalSessionKey(interval),
      list = target.get(key) || [];
    list.push(interval);
    target.set(key, list);
  }
  return { grouped, running };
}
