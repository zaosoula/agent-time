import type { AgentLoadSegment } from './timeline-groups.ts';

/** Time-weighted concurrency while at least one agent is active; idle gaps are excluded. */
export function parallelism(load: readonly AgentLoadSegment[]): { average: number | null; activeSeconds: number } {
  let activeSeconds = 0, agentSeconds = 0;
  for (const segment of load) {
    const seconds = Math.max(0, segment.end - segment.start);
    const agents = segment.roots + segment.children;
    if (!seconds || agents <= 0) continue;
    activeSeconds += seconds;
    agentSeconds += seconds * agents;
  }
  return { average: activeSeconds ? agentSeconds / activeSeconds : null, activeSeconds };
}

/** Only shade genuine gaps between recorded activity, including short bursts and human activity. */
export function inactivityGaps(spans: readonly { start: number; end: number }[], minimumSeconds = 1800): Array<{ start: number; end: number }> {
  const ordered = spans.filter((span) => span.end > span.start).map((span) => ({ ...span })).sort((a, b) => a.start - b.start);
  const gaps: Array<{ start: number; end: number }> = [];
  let until = ordered[0]?.end;
  for (const span of ordered.slice(1)) {
    if (until !== undefined && span.start - until >= minimumSeconds) gaps.push({ start: until, end: span.start });
    until = Math.max(until ?? span.end, span.end);
  }
  return gaps;
}
