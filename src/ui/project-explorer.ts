import type { Interval } from '../capture/events.ts';
import { minuteCreditSeconds } from '../capture/correlate.ts';
import type { ReportedWorkItem } from '../capture/reported-work.ts';
import { agentLoadSegments, type AgentLoadSegment } from './timeline-groups.ts';
import type { DaySession, TimelineGroup, TimelineSessionRow } from './store.ts';

/** One agent execution inside a session: the main agent or one of its subagents. */
export interface AgentExecution {
  key: string;
  session: DaySession;
  child: boolean;
  /** Measured agent time for this execution alone, as aggregated by capture. */
  seconds: number;
  /** First and last observed activity, or null when no interval is on this day. */
  start: number | null;
  end: number | null;
  bars: Interval[];
}

/** A main agent session and the subagents it started, as shown in the session explorer. */
export interface ExplorerSession {
  key: string;
  session: DaySession;
  title: string;
  start: number | null;
  end: number | null;
  /** Cumulative: the main session plus each subagent, each counted in full, as elsewhere in the app. */
  agentSeconds: number;
  /** Clock time with this session or any of its subagents working; overlaps counted once. */
  wallSeconds: number;
  executions: AgentExecution[];
  subagents: number;
  load: AgentLoadSegment[];
  peak: number;
  /**
   * Your activity tied to this session (for example, its Orca tab in focus). Null when capture has
   * no session-level link: project-level time is never split across sessions.
   */
  humanSeconds: number | null;
  /** Agent-reported context and timers from this session, kept apart from measured time. */
  reported: ReportedWorkItem[];
}

const span = (bars: Interval[]) =>
  bars.length
    ? { start: Math.min(...bars.map((bar) => bar.start)), end: Math.max(...bars.map((bar) => bar.end)) }
    : { start: null, end: null };

function execution(row: TimelineSessionRow): AgentExecution {
  const { start, end } = span(row.bars);
  return {
    key: row.session.key,
    session: row.session,
    child: Boolean(row.session.child),
    seconds: row.session.seconds,
    start,
    end,
    bars: row.bars,
  };
}

/**
 * Sessions of one project for the explorer, built from the store's project group: no figures are
 * recomputed except per-session totals, which reuse each session's own aggregated seconds.
 */
export function explorerSessions(
  group: Pick<TimelineGroup, 'rows'>,
  humanBySession: ReadonlyMap<string, Interval[]>,
  reported: ReportedWorkItem[] = [],
): ExplorerSession[] {
  const childrenOf = new Map<string, TimelineSessionRow[]>();
  for (const row of group.rows)
    if (row.session.child && row.parentKey)
      childrenOf.set(row.parentKey, [...(childrenOf.get(row.parentKey) || []), row]);
  const roots = group.rows.filter((row) => !row.session.child);
  // Subagents whose parent session is not on this day still appear, as sessions of their own.
  const orphans = group.rows.filter(
    (row) => row.session.child && (!row.parentKey || !roots.some((root) => root.session.key === row.parentKey)),
  );
  return [...roots, ...orphans]
    .map((row) => {
      const kids = row.session.child ? [] : childrenOf.get(row.session.key) || [];
      const executions = [execution(row), ...kids.map(execution).sort((a, b) => (a.start ?? 0) - (b.start ?? 0))];
      const bars = executions.flatMap((item) => item.bars);
      const { start, end } = span(bars);
      const load = agentLoadSegments(row.bars, kids.flatMap((kid) => kid.bars));
      const human = humanBySession.get(row.session.key);
      return {
        key: row.session.key,
        session: row.session,
        title: row.session.title,
        start,
        end,
        agentSeconds: executions.reduce((sum, item) => sum + item.seconds, 0),
        wallSeconds: minuteCreditSeconds(bars.map((bar) => [bar.start, bar.end])),
        executions,
        subagents: kids.length,
        load,
        peak: Math.max(0, ...load.map((step) => step.roots + step.children)),
        humanSeconds: human?.length ? minuteCreditSeconds(human.map((interval) => [interval.start, interval.end])) : null,
        reported: reported.filter(
          (item) =>
            item.sessionId &&
            item.sessionId === row.session.sessionId &&
            (!item.provider || item.provider === row.session.provider),
        ),
      };
    })
    .sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity));
}

/** Coarse bars for a project row's activity preview: peak agents per bucket across the day. */
export function activityPreview(load: AgentLoadSegment[], dayStart: number, dayEnd: number, buckets = 96): number[] {
  const width = (dayEnd - dayStart) / buckets,
    result = new Array<number>(buckets).fill(0);
  for (const step of load) {
    const first = Math.max(0, Math.floor((step.start - dayStart) / width)),
      last = Math.min(buckets - 1, Math.floor((Math.max(step.start, step.end - 1) - dayStart) / width));
    for (let index = first; index <= last; index++)
      result[index] = Math.max(result[index]!, step.roots + step.children);
  }
  return result;
}
