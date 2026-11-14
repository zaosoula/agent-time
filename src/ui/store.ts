import {requestReviewFocus} from './review-workspace.ts';
import {createWorkspaceScope} from './workspace-scope.ts';
import {emptyActivityFilters,filterActivity,type ActivityFilters} from '../capture/activity-filter.ts';
// Shared dashboard state. One store owns every poll and every value that several views need, so the
// same data is fetched and derived once, polling pauses while the window is hidden, and each poll only
// runs while a page that shows its data is open.
import { computed, effectScope, markRaw, ref, shallowRef, watch } from 'vue';
import type { Interval, Session, Summary } from '../capture/events.ts';
import type { CaptureHealth } from '../capture/health.ts';
import type { HookInstallationStatus } from '../capture/hook-installation.ts';
import type { ReportedWorkItem } from '../capture/reported-work.ts';
import type { ManualNote } from '../capture/store.ts';
import type { UsageSummary } from '../usage/reader.ts';
import { minuteCreditSeconds, unionSeconds } from '../capture/correlate.ts';
import { dailyCaptureIssues } from '../capture/daily.ts';
import { dayConfidence } from '../capture/day-confidence.ts';
import { unobservedGaps } from '../capture/gaps.ts';
import { outdatedHookTargets } from '../capture/hook-warning.ts';
import { groupHumanReview, humanReviewState, type HumanReviewGroup } from '../capture/human-review.ts';
import {buildAppReviewGroups,reviewContextGroups,type AppReviewGroup} from './review-apps.ts';
import { humanIntervalsBySession } from '../capture/orca-focus.ts';
import {
  dayReviewTransport,
  manualNoteTransport,
  native,
  reportedWorkTransport,
  transport,
  type CaptureStatus,
  type DayReviewStatus,
  type WebsiteProjectStatus,
} from './transport.ts';
import { humanizeError, isRetryableError } from './errors.ts';
import { dateString, isValidDateString } from './format.ts';
import { createPoller, watchWindowVisibility, windowFocused, windowVisible } from './polling.ts';
import { intervalProject, sessionProject, unassignedProject, workspaceProject } from './project-identity.ts';
import { indexSessionIntervals, intervalSessionKey, sessionIntervalKey } from './session-intervals.ts';
import {
  agentLoadSegments,
  creditedIntervals,
  groupTimelineProjects,
  type TimelineProjectGroup,
} from './timeline-groups.ts';

export type Page =
  | 'today'
  | 'review'
  | 'sessions'
  | 'billing'
  | 'weekly'
  | 'outcomes'
  | 'health'
  | 'usage'
  | 'settings'
  | 'projects'
  | 'reports';

/** A session row with its credited seconds for the selected day. */
export type DaySession = Session & { seconds: number; observedSeconds: number };

/** A timeline row with everything it draws precomputed once per summary change. */
export interface TimelineSessionRow {
  session: DaySession;
  parentKey: string | null;
  childCount: number;
  bars: Interval[];
  creditBars: Interval[];
  childBars: Interval[];
  childCreditBars: Interval[];
}
export type TimelineGroup = TimelineProjectGroup & { rows: TimelineSessionRow[] };

const emptySummary: Summary = markRaw({
  intervals: [],
  unresolved: [],
  coverage: [],
  sessions: [],
  humanSeconds: 0,
  agentSeconds: 0,
  elapsedSeconds: 0,
  childAgentSeconds: 0,
});

/**
 * Cheap fingerprint of a summary. Walking the arrays once is far cheaper than letting ~40 computeds
 * rebuild every five seconds when nothing changed.
 */
export function summarySignature(summary: Summary): string {
  let hash = 0x811c9dc5;
  const mix = (value: unknown) => {
    const text = String(value ?? '');
    for (let index = 0; index < text.length; index++) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
  };
  for (const interval of summary.intervals) {
    mix(interval.start);
    mix(interval.end);
    mix(interval.state);
    mix(interval.workspaceId);
    mix(interval.userAttribution);
    mix(interval.reviewSegment);
    mix(interval.attributionSource);
  }
  for (const session of summary.sessions) {
    mix(session.key);
    mix(session.state);
    mix(session.lastObservedAt);
    mix(session.title);
  }
  return [
    summary.intervals.length,
    summary.sessions.length,
    summary.unresolved.length,
    summary.coverage.length,
    summary.humanSeconds,
    summary.agentSeconds,
    summary.elapsedSeconds,
    (summary.issueReasons || []).join('|'),
    hash >>> 0,
  ].join(':');
}

const evidenceKey = intervalSessionKey;

function createStore() {
  watchWindowVisibility();

  // ---- Navigation and selection -------------------------------------------------------------
  const page = ref<Page>('today');
  const settingsSection = ref('general');
  const settingsNavigationRequest = ref(0);
  const connectionsSection = ref<'agents'|'sources'|'linear'|'health'>('sources');
  const reportsSection = ref<'time'|'usage'|'evidence'|'billing'>('time');
  const projectsSection = ref<'overview'|'attribution'|'billing'|'evidence'>('overview');
  const billingSettingsProject = ref('');
  const usageFocus = ref<'limits'|''>('');
  const billingProjectRevision = ref(0);
  const project = ref('all');
  const search = ref('');
  const pageFilters=ref<Record<string,ActivityFilters>>({today:emptyActivityFilters(),review:emptyActivityFilters(),time:emptyActivityFilters(),evidence:emptyActivityFilters()});
  watch(search,value=>{if(pageFilters.value.today!.search!==value)pageFilters.value.today!.search=value;});
  const filterKey=computed(()=>page.value==='reports'?reportsSection.value:page.value);
  const activityFilters=computed(()=>pageFilters.value[filterKey.value]||emptyActivityFilters());
  function setActivityFilters(value:ActivityFilters){pageFilters.value={...pageFilters.value,[filterKey.value]:value};if(filterKey.value==='today')search.value=value.search;}

  const selectedDate = ref(dateString(new Date()));
  const workspaceScope=createWorkspaceScope(selectedDate);
  const selectedSessionKey = ref('');
  /** Ticks every second while visible; only the now-cursor and live labels read it. */
  const now = ref(Date.now() / 1000);
  /** Minute-rounded clock for anything that should not re-render every second. */
  const minute = computed(() => Math.floor(now.value / 60) * 60);

  /** Website prefix the review queue is filtered to, set from Capture health. */
  const reviewSiteFilter = ref('');
  const reviewProjectFilter = project;

  function navigate(destination: Page, nextProject?: string) {
    // Native menus and older links retain their destination IDs.
    if (destination === 'weekly' || destination === 'usage' || destination === 'outcomes' || destination === 'billing') {
      reportsSection.value = destination === 'weekly' ? 'time' : destination === 'usage' ? 'usage' : destination === 'billing' ? 'billing' : 'evidence';
      destination = 'reports';
    } else if (destination === 'sessions') {
      destination = 'today';
    } else if (destination === 'health') {
      settingsSection.value = 'connections';connectionsSection.value = 'health';destination = 'settings';
    }
    page.value = destination;
    if (nextProject !== undefined && nextProject !== project.value) {
      project.value = nextProject;
      selectedSessionKey.value = '';
    }
  }

  function openSettings(section = 'general', connection?: 'agents'|'sources'|'linear'|'health') {
    settingsNavigationRequest.value++;
    settingsSection.value = section;
    if (connection) connectionsSection.value = connection;
    navigate('settings');
  }
  function openProject(path?: string, section?: 'overview'|'attribution'|'billing'|'evidence', billingProjectId?: string) {
    if (section) projectsSection.value = section;
    if (billingProjectId !== undefined) billingSettingsProject.value = billingProjectId;
    navigate('projects', path);
  }
  function openUsageLimits() {
    usageFocus.value = 'limits';reportsSection.value = 'usage';navigate('reports');
  }

  function setDate(value: string) {
    if (!isValidDateString(value) || value === selectedDate.value) return false;
    selectedDate.value = value;
    return true;
  }

  function openReview(date:string,nextProject=project.value,ids:string[]=[],filters?:ActivityFilters,groups?:AppReviewGroup[]){
    if(!isValidDateString(date))return;
    setDate(date);
    reviewSiteFilter.value='';
    pageFilters.value={...pageFilters.value,review:filters?{...filters}:emptyActivityFilters()};
    navigate('review',nextProject);
    requestReviewFocus(date,ids,groups);
  }

  // ---- Fetched state -----------------------------------------------------------------------
  const summary = shallowRef<Summary>(emptySummary);
  const knownProjects=ref<string[]>([]);
  const reportFilterOptions=ref<{app:string[];site:string[];device:string[]}>({app:[],site:[],device:[]});
  const summaryLoaded = ref(false);
  const status = shallowRef<CaptureStatus | null>(null);
  const captureHealth = shallowRef<CaptureHealth | null>(null);
  const hookStatus = shallowRef<HookInstallationStatus | null>(null);
  const websiteProjects = shallowRef<WebsiteProjectStatus | null>(null);
  const usage = shallowRef<UsageSummary | null>(null);
  const usageError = ref('');
  const reportedWork = shallowRef<ReportedWorkItem[]>([]);
  const dayReview = ref<DayReviewStatus | null>(null);
  const notes = ref<ManualNote[]>([]);
  /** Error from the background summary/status poll. Cleared by the next successful poll. */
  const pollError = ref('');
  const reviewRevision = ref(0);

  let summaryKey = '',
    summaryRevision = 0,
    summaryFetchedAt = 0;

  /** Collector version of the summary on screen; polls skip the download while it is current. */
  let summaryToken: string | undefined;
  let reportedWorkInflight: Promise<void> | undefined;
  function storeSummary(next: Summary, date: string) {
    summaryToken = undefined;
    const key = `${date}|${summarySignature(next)}`;
    summaryFetchedAt = Date.now();
    summaryLoaded.value = true;
    if (key === summaryKey) return;
    summaryKey = key;
    summary.value = markRaw(next);
    knownProjects.value=[...new Set([...knownProjects.value,...next.sessions.map(sessionProject),...next.intervals.map(intervalProject)].filter(p=>p.startsWith('/')))].sort();
  }

  const summaryPages: Page[] = ['today', 'sessions', 'review', 'projects'];
  const showsSummary = computed(() => summaryPages.includes(page.value) || page.value === 'reports' && reportsSection.value === 'evidence');

  async function loadSummary() {
    const date = selectedDate.value,
      revision = summaryRevision;
    // The desktop window can stay visible behind other apps; then a lighter background summary is enough.
    const background = native && !windowFocused.value;
    // While visible but unfocused, a full summary every minute is enough.
    const due = !background || summaryKey.split('|')[0] !== date || Date.now() - summaryFetchedAt >= 60_000;
    try {
      const nextRequest = due
        ? transport.summarySince(date, background, summaryKey.split('|')[0] === date ? summaryToken : undefined)
        : Promise.resolve(null);
      if (!reportedWorkInflight) reportedWorkInflight = reportedWorkTransport.list(date).then(reports => {
        if (revision === summaryRevision && date === selectedDate.value) reportedWork.value = markRaw(reports);
      }).catch(() => { /* Optional declarations must not delay measured activity. */ }).finally(() => { reportedWorkInflight = undefined; });
      const next = await nextRequest;
      if (revision !== summaryRevision || date !== selectedDate.value) return;
      if (next && 'unchanged' in next) {
        summaryFetchedAt = Date.now();
        summaryLoaded.value = true;
      } else if (next) {
        const { token, ...rest } = next;
        storeSummary(rest as Summary, date);
        summaryToken = token;
      }
      pollError.value = '';
    } catch (cause) {
      if (revision === summaryRevision && !isRetryableError(cause)) pollError.value = humanizeError(cause);
    }
  }

  async function loadStatus() {
    try {
      status.value = await transport.status();
      pollError.value = '';
    } catch (cause) {
      // Restarts and storage operations clear on their own; the next poll retries silently.
      if (!isRetryableError(cause)) pollError.value = humanizeError(cause);
    }
  }

  async function loadHealth() {
    try {
      captureHealth.value = markRaw(await transport.captureHealth());
    } catch {
      /* Capture health shows its own error on its page. */
    }
  }

  async function loadHooks() {
    try {
      hookStatus.value = await transport.hooksStatus();
    } catch {
      /* Hook setup reports its own errors when opened. */
    }
  }

  /** Website rules and known projects. Throws so callers can report their own errors. */
  async function loadWebsiteProjects() {
    websiteProjects.value = markRaw(await transport.websiteProjects());
    return websiteProjects.value;
  }

  async function loadUsage() {
    try {
      usage.value = markRaw(await transport.usage());
      usageError.value = '';
    } catch (cause) {
      if (!isRetryableError(cause)) usageError.value = humanizeError(cause);
    }
  }

  const dayReviewLoading = ref(false), backlogLoading = ref(false), dayReviewRequest = ref(0);
  async function loadDayReview() {
    const attempt = ++dayReviewRequest.value;
    const date = selectedDate.value;
    dayReviewLoading.value = true;
    backlogLoading.value = false;
    try {
      const value = await dayReviewTransport.status(date, false);
      if (attempt !== dayReviewRequest.value || date !== selectedDate.value) return;
      dayReview.value = value;
      dayReviewLoading.value = false;
      if (page.value === 'review') {
        backlogLoading.value = true;
        const complete = await dayReviewTransport.status(date, true);
        if (attempt === dayReviewRequest.value && date === selectedDate.value) dayReview.value = complete;
      }
    } catch {
      /* Keep current-day data when the optional backlog could not be read. */
    } finally {
      if (attempt === dayReviewRequest.value && date === selectedDate.value) {
        dayReviewLoading.value = false;
        backlogLoading.value = false;
      }
    }
  }

  async function loadNotes() {
    const date = selectedDate.value;
    try {
      const result = await manualNoteTransport.list(date);
      if (date === selectedDate.value) notes.value = result;
    } catch {
      /* Notes stay empty; adding a note reports its own error. */
    }
  }

  // ---- Polling -----------------------------------------------------------------------------
  const visible = () => windowVisible.value;
  const pollers = {
    summary: createPoller(loadSummary, () =>
      visible() && showsSummary.value ? (!native || windowFocused.value ? 5_000 : 60_000) : null,
    ),
    status: createPoller(loadStatus, () => (visible() ? 5_000 : null)),
    // The sidebar status line needs health everywhere; the Health page needs it fresh.
    health: createPoller(loadHealth, () => (visible() ? (page.value === 'settings' && settingsSection.value === 'connections' && connectionsSection.value === 'health' ? 5_000 : 30_000) : null)),
    hooks: createPoller(loadHooks, () => (visible() ? 30_000 : null)),
    usage: createPoller(loadUsage, () => (visible() && page.value === 'reports' && reportsSection.value === 'usage' ? 60_000 : null)),
    websites: createPoller(loadWebsiteProjects, () =>
      visible() && page.value === 'projects' && projectsSection.value === 'attribution' ? 30_000 : null,
    ),
    dayReview: createPoller(loadDayReview, () => (visible() && summaryLoaded.value && ['today', 'review'].includes(page.value) ? 60_000 : null)),
  };
  const syncPollers = () => {
    for (const poller of Object.values(pollers)) poller.sync();
  };
  watch([windowVisible, windowFocused, page, settingsSection, connectionsSection, reportsSection, projectsSection, summaryLoaded], syncPollers);
  // Pollers that just became enabled run immediately on sync. Health is always polled (slowly), so
  // opening its page asks for a fresh snapshot instead of waiting up to 30 seconds.
  watch(page, (next) => {
    if (windowVisible.value && next === 'settings' && settingsSection.value === 'connections' && connectionsSection.value === 'health') void pollers.health.refresh();
    if (windowVisible.value && summaryLoaded.value && next === 'review') void pollers.dayReview.refresh();
  });
  // Coming back into view: refresh straight away rather than waiting for the next tick.
  watch(windowVisible, (shown) => {
    if (shown) {
      now.value = Date.now() / 1000;
      if (showsSummary.value) void pollers.summary.refresh();
      void pollers.status.refresh();
      void pollers.health.refresh();
    }
  });

  let clockTimer: ReturnType<typeof setInterval> | undefined;
  let previousDay = dateString(new Date());
  function tickClock() {
    now.value = Date.now() / 1000;
    const currentDay = dateString(new Date());
    if (currentDay !== previousDay) {
      if (selectedDate.value === previousDay) selectedDate.value = currentDay;
      previousDay = currentDay;
    }
  }
  watch(
    windowVisible,
    (shown) => {
      clearInterval(clockTimer);
      if (shown) clockTimer = setInterval(tickClock, 1000);
    },
    { immediate: true },
  );

  watch(selectedDate, () => {
    dayReviewRequest.value++;
    dayReviewLoading.value=false;backlogLoading.value=false;
    summaryRevision++;
    // Drop the previous day's summary so the page shows loading, not an empty day, until this one arrives.
    summaryLoaded.value = false;
    summary.value = emptySummary;
    summaryKey = '';
    summaryToken = undefined;
    selectedSessionKey.value = '';
    dayReview.value = null;
    notes.value = [];
    reportedWork.value = [];
    void loadNotes();
    void pollers.summary.refresh();
  });

  let started = false;
  function start() {
    if (started) return;
    started = true;
    syncPollers();
    void loadNotes();
  }

  /** Apply the summary a review action returned, or refetch when it is for another day. */
  function applyReviewedSummary(next: Summary, date: string) {
    reviewRevision.value++;
    const reportedDate = (next as Summary & { date?: unknown }).date;
    if (date !== selectedDate.value || (typeof reportedDate === 'string' && reportedDate !== date)) {
      summaryRevision++;
      void pollers.summary.refresh();
    } else {
      summaryRevision++;
      storeSummary(next, date);
    }
    void loadDayReview();
  }

  async function markDayReviewed() {
    const date = selectedDate.value;
    const value = await dayReviewTransport.mark(date);
    if (date === selectedDate.value) {
      dayReviewRequest.value++;dayReviewLoading.value=false;backlogLoading.value=false;
      dayReview.value = value;
    }
    reviewRevision.value++;
    return value;
  }

  // ---- Day boundaries ----------------------------------------------------------------------
  const isToday = computed(() => selectedDate.value === dateString(new Date(minute.value * 1000)));
  const dayStart = computed(() => new Date(`${selectedDate.value}T00:00:00`).getTime() / 1000);
  const dayEnd = computed(() => {
    const date = new Date(`${selectedDate.value}T00:00:00`);
    date.setDate(date.getDate() + 1);
    return date.getTime() / 1000;
  });

  // ---- Day data ----------------------------------------------------------------------------
  const dayIntervals = computed(() => {
    const start = dayStart.value,
      end = dayEnd.value;
    return summary.value.intervals
      .filter((interval) => interval.end > start && interval.start < end)
      .map((interval) => ({
        ...interval,
        start: Math.max(interval.start, start),
        end: Math.min(interval.end, end),
      }));
  });
  // Home filters stay local even while this shared data feeds Projects or Evidence.
  const homeFilters=computed(()=>page.value==='today'?pageFilters.value.today!:emptyActivityFilters());
  const effectiveSearch=computed(()=>page.value==='today'?search.value:'');
  const homeIntervals=computed(()=>filterActivity({...summary.value,intervals:dayIntervals.value},homeFilters.value));
  const daySessionIntervals = computed(() => indexSessionIntervals(homeIntervals.value));
  const firstSessionByEvidence = computed(() => {
    const sessions = new Map<string, Session>();
    for (const session of summary.value.sessions) {
      const key = evidenceKey(session);
      if (!sessions.has(key)) sessions.set(key, session);
    }
    return sessions;
  });

  /** Projects with credited work on the selected day. */
  const projects = computed(() => {
    const worked = new Set<string>();
    for (const interval of dayIntervals.value) {
      if (interval.state !== 'grouped' && interval.state !== 'human') continue;
      const session =
        interval.state === 'grouped' ? firstSessionByEvidence.value.get(evidenceKey(interval)) : undefined;
      const name = interval.projectPath || interval.userAttribution
        ? intervalProject(interval)
        : session
          ? sessionProject(session)
          : interval.workspaceId
            ? workspaceProject(interval.workspaceId)
            : unassignedProject;
      if (name !== unassignedProject) worked.add(name);
    }
    return [...worked].sort();
  });

  const allSessions = computed<DaySession[]>(() =>
    summary.value.sessions
      .map((session) => {
        const key = sessionIntervalKey(session),
          grouped = daySessionIntervals.value.grouped.get(key) || [],
          running = daySessionIntervals.value.running.get(key) || [];
        return {
          ...session,
          seconds: minuteCreditSeconds(grouped.map((interval) => [interval.start, interval.end])),
          observedSeconds: unionSeconds(running.map((interval) => [interval.start, interval.end])),
        };
      })
      .filter((session) => (project.value === 'all' || sessionProject(session) === (project.value==='unassigned'?unassignedProject:project.value)) && (homeFilters.value.app||homeFilters.value.site||homeFilters.value.device||homeFilters.value.assignment!=='all'?daySessionIntervals.value.grouped.has(sessionIntervalKey(session)):true))
      .sort((a, b) => b.seconds - a.seconds || b.lastObservedAt - a.lastObservedAt),
  );
  const sessions = computed(() => {
    const query = effectiveSearch.value.trim().toLowerCase();
    if (!query) return allSessions.value;
    return allSessions.value.filter((session) =>
      [
        session.title,
        sessionProject(session).split('/').at(-1),
        sessionProject(session),
        session.runId,
        session.provider,
      ]
        .join(' ')
        .toLowerCase()
        .includes(query),
    );
  });
  const visibleSessions = computed(() => sessions.value.filter((session) => session.seconds > 0));
  const creditedSessions = computed(() => allSessions.value.filter((session) => session.seconds > 0));
  const timelineEligible = computed(() => {
    const activeChildren = new Set(
      sessions.value
        .filter((session) => session.child && session.seconds > 0)
        .map((session) => JSON.stringify([session.hostId ?? null, session.sessionId ?? null])),
    );
    return sessions.value.filter(
      (session) =>
        session.seconds > 0 ||
        (!session.child && activeChildren.has(JSON.stringify([session.hostId ?? null, session.sessionId ?? null]))),
    );
  });
  const humanBySession = computed(() => humanIntervalsBySession(summary.value.sessions, homeIntervals.value));
  const visibleSessionKeys = computed(() => new Set(creditedSessions.value.map(sessionIntervalKey)));
  const filteredIntervals = computed(() =>
    project.value === 'all'
      ? homeIntervals.value
      : homeIntervals.value.filter((interval) => {
          if (interval.state === 'human')
            return intervalProject(interval) === (project.value==='unassigned'?unassignedProject:project.value);
          return visibleSessionKeys.value.has(intervalSessionKey(interval));
        }),
  );
  const visibleReportedWork = computed(() =>
    reportedWork.value.filter(
      (item) =>
        project.value === 'all' ||
        item.project === project.value ||
        Boolean((item.workspaceId || item.projectPath) && workspaceProject(item.workspaceId, item.projectPath) === project.value) ||
        Boolean(
          item.sessionId &&
          summary.value.sessions.some(
            (session) =>
              session.sessionId === item.sessionId &&
              session.provider === item.provider &&
              sessionProject(session) === project.value,
          ),
        ),
    ),
  );

  /** Cumulative agent time: every main session and every subagent counted in full. */
  const mainAgentTime = computed(() =>
    creditedSessions.value.filter((session) => !session.child).reduce((sum, session) => sum + session.seconds, 0),
  );
  const subagentTime = computed(() =>
    creditedSessions.value.filter((session) => session.child).reduce((sum, session) => sum + session.seconds, 0),
  );
  const agentTime = computed(() => mainAgentTime.value + subagentTime.value);
  /** Clock time with at least one agent or subagent working; overlaps counted once. */
  const agentWallTime = computed(() => {
    const grouped = filteredIntervals.value.filter((interval) => interval.state === 'grouped');
    const work = grouped.length
      ? grouped
      : filteredIntervals.value.filter((interval) => interval.state === 'running' || interval.state === 'turn');
    return minuteCreditSeconds(work.map((interval) => [interval.start, interval.end]));
  });
  const agentOverlap = computed(() => {
    const grouped = filteredIntervals.value.filter((interval) => interval.state === 'grouped' && !interval.child);
    const roots = grouped.length
      ? grouped
      : filteredIntervals.value.filter(
          (interval) => (interval.state === 'running' || interval.state === 'turn') && !interval.child,
        );
    const steps = agentLoadSegments(roots, []).filter(
      (step) => step.end > dayStart.value && step.start < dayEnd.value,
    );
    return {
      steps,
      seconds: steps
        .filter((step) => step.roots > 1)
        .reduce(
          (total, step) => total + Math.min(step.end, dayEnd.value) - Math.max(step.start, dayStart.value),
          0,
        ),
      peak: Math.max(0, ...steps.map((step) => step.roots)),
    };
  });
  const humanTime = computed(() =>
    minuteCreditSeconds(
      filteredIntervals.value
        .filter((interval) => interval.state === 'human')
        .map((interval) => [interval.start, interval.end]),
    ),
  );
  const elapsedTime = computed(() =>
    minuteCreditSeconds(
      filteredIntervals.value
        .filter((interval) => interval.state === 'grouped' || interval.state === 'human')
        .map((interval) => [interval.start, interval.end]),
    ),
  );
  const runningCount = computed(() =>
    project.value === 'all' && typeof status.value?.workingAgents === 'number'
      ? status.value.workingAgents
      : creditedSessions.value.filter(
          (session) => ['working', 'running'].includes(session.state) && now.value - session.lastObservedAt < 20,
        ).length,
  );
  const runs = computed(
    () => new Set(creditedSessions.value.map((session) => session.runId).filter(Boolean)).size,
  );

  /** Agent-reported timers still running on the selected day, across all projects. */
  const runningTimers = computed(() =>
    reportedWork.value.filter((item) => item.kind === 'counter' && item.active).sort((a, b) => a.start - b.start),
  );
  async function stopTimer(id: string, discard = false) {
    await stopTimers([id], discard);
  }
  /** Stop or discard several timers, refreshing the day once. */
  async function stopTimers(ids: string[], discard = false) {
    const done = new Set<string>();
    try {
      for (const id of ids) {
        await reportedWorkTransport.stop(id, discard);
        done.add(id);
      }
    } finally {
      if (discard) reportedWork.value = markRaw(reportedWork.value.filter((item) => !done.has(item.id)));
      await pollers.summary.refresh();
    }
  }
  /** Key linking reported work to the agent session row that reported it. */
  const reportedSessionKey = (provider: string | undefined, sessionId: string | undefined) =>
    `${provider || ''}:${sessionId || ''}`;
  /** Project a reported item belongs to: its workspace, its agent session, or a uniquely named project. */
  function reportedProject(item: ReportedWorkItem, projectNames: string[]): string | undefined {
    const workspace = workspaceProject(item.workspaceId, item.projectPath);
    if (workspace !== unassignedProject) return workspace;
    const session =
      item.sessionId &&
      summary.value.sessions.find(
        (candidate) => candidate.sessionId === item.sessionId && (!item.provider || candidate.provider === item.provider),
      );
    if (session && sessionProject(session) !== unassignedProject) return sessionProject(session);
    if (!item.project) return undefined;
    const named = projectNames.filter(
      (name) => name === item.project || name.split('/').filter(Boolean).at(-1) === item.project,
    );
    return named.length === 1 ? named[0] : undefined;
  }
  /** Reported work shown inside its project's row; anything without a visible project stays on top. */
  const reportedPlacement = computed(() => {
    const names = timelineProjects.value.map((group) => group.name),
      visible = new Set(names);
    const byProject = new Map<string, ReportedWorkItem[]>(),
      bySession = new Map<string, ReportedWorkItem[]>(),
      unplaced: ReportedWorkItem[] = [];
    for (const item of visibleReportedWork.value)
      if (item.sessionId) {
        const key = reportedSessionKey(item.provider, item.sessionId);
        bySession.set(key, [...(bySession.get(key) || []), item]);
      }
    for (const item of visibleReportedWork.value) {
      const project = reportedProject(item, names);
      if (project && visible.has(project)) byProject.set(project, [...(byProject.get(project) || []), item]);
      else unplaced.push(item);
    }
    return { byProject, bySession, unplaced };
  });
  const timelineProjects = computed<TimelineGroup[]>(() => {
    const groups = groupTimelineProjects(
      timelineEligible.value,
      filteredIntervals.value.filter((interval) => interval.state === 'human'),
      humanBySession.value,
      (session) => daySessionIntervals.value.grouped.get(sessionIntervalKey(session)) || [],
      sessionProject,
      workspaceProject,
      !effectiveSearch.value.trim(),
    );
    return groups.map((group) => {
      const ordered = (group.sessions as DaySession[]).sort((a, b) => {
        if (a.runId !== b.runId) return (a.runId || '').localeCompare(b.runId || '');
        if (a.sessionId === b.sessionId && a.child !== b.child) return a.child ? 1 : -1;
        return (a.sessionId || a.key).localeCompare(b.sessionId || b.key) || (a.child ? 1 : 0) - (b.child ? 1 : 0);
      });
      // Index parents and children once instead of scanning the group for every row.
      const familyKey = (session: Session) => JSON.stringify([session.hostId ?? null,session.provider??null, session.sessionId ?? null]);
      const parents = new Map<string, DaySession>(),
        children = new Map<string, DaySession[]>();
      for (const session of ordered) {
        const key = familyKey(session);
        if (session.child) children.set(key, [...(children.get(key) || []), session]);
        else if (!parents.has(key)) parents.set(key, session);
      }
      const barsOf = (session: Session) =>
        daySessionIntervals.value.grouped.get(sessionIntervalKey(session)) || [];
      const rows = ordered.map((session): TimelineSessionRow => {
        const family = familyKey(session),
          kids = session.child ? [] : children.get(family) || [],
          bars = barsOf(session);
        return {
          session,
          parentKey: session.child ? parents.get(family)?.key || null : null,
          childCount: kids.length,
          bars,
          creditBars: creditedIntervals(bars),
          childBars: kids.flatMap(barsOf),
          childCreditBars: kids.flatMap((child) => creditedIntervals(barsOf(child))),
        };
      });
      return { ...group, sessions: ordered, rows };
    });
  });

  const issues = computed(
    () =>
      summary.value.issueReasons ?? [
        ...new Set([...summary.value.coverage, ...summary.value.unresolved].map((issue) => issue.reason)),
      ],
  );
  const dayCaptureIssues = computed(() => dailyCaptureIssues(summary.value, dayStart.value, dayEnd.value));
  const dayCaptureReasons = computed(() => [...new Set(dayCaptureIssues.value.map((issue) => issue.reason))]);
  const confidence = computed(() =>
    dayConfidence(
      summary.value,
      captureHealth.value?.sources || [],
      status.value?.sources.filter((source) => source.kind === 'agent').map((source) => source.id) || [],
      dayStart.value,
      dayEnd.value,
      isToday.value,
    ),
  );
  const observedAgentSources = computed(
    () =>
      confidence.value.sources.filter(
        (source) =>
          source.observed &&
          status.value?.sources.some((item) => item.kind === 'agent' && item.id === source.id),
      ).length,
  );

  // ---- Review ------------------------------------------------------------------------------
  const appReviewGroups = computed(() => buildAppReviewGroups(dayIntervals.value));
  const reviewContexts = computed(() => reviewContextGroups(appReviewGroups.value));
  const reviewContextPending = computed(() => reviewContexts.value.filter(context=>['unmatched','conflict'].includes(humanReviewState(context.groups[0]!))));
  const reviewContextCaptured = computed(() => reviewContexts.value.filter(context=>humanReviewState(context.groups[0]!)==='captured'));
  /** Original review groups remain available for exports and existing consumers. */
  const reviewGroups = computed<HumanReviewGroup[]>(() => groupHumanReview(dayIntervals.value));
  const exportReviewGroups = computed(() =>
    project.value === 'all' ? reviewGroups.value : groupHumanReview(filteredIntervals.value),
  );
  const reviewPending = computed(() =>
    reviewGroups.value.filter((group) => ['unmatched', 'conflict'].includes(humanReviewState(group))),
  );
  const reviewCaptured = computed(() =>
    reviewGroups.value.filter((group) => humanReviewState(group) === 'captured'),
  );
  const dayReviewed = computed(() => Boolean(dayReview.value?.completedAt && !dayReview.value.stale));
  /** Count shown on the Review navigation item. */
  const reviewBadge = computed(() =>
    summaryLoaded.value ? reviewContextPending.value.length : 0,
  );
  const dayGaps = computed(() => unobservedGaps(dayIntervals.value));

  // ---- Capture status ----------------------------------------------------------------------
  const sourceProblems = computed(
    () =>
      captureHealth.value?.sources.filter((source) => source.state === 'stale' || source.state === 'failed') ||
      [],
  );
  const outdatedHooks = computed(() => outdatedHookTargets(status.value, hookStatus.value));
  const outdatedAgents = computed(() =>
    [
      ...new Set(
        outdatedHooks.value.map(
          (target) =>
            hookStatus.value?.agents.find((agent) => agent.id === target.provider)?.name || target.provider,
        ),
      ),
    ].join(', '),
  );
  const captureAttention = computed(
    () =>
      ['repair-needed', 'failed', 'stale', 'permission-limited'].flatMap(
        (state) => captureHealth.value?.sources.filter((source) => source.state === state) || [],
      )[0],
  );
  const captureLabel = computed(() => {
    const attention = captureAttention.value;
    if (!status.value) return 'Checking capture…';
    if (status.value.storageCare?.paused) return 'Capture paused: storage full';
    if (!status.value.running) return 'Mac tracking paused';
    if (attention?.state === 'repair-needed') return `${attention.name}: repair hooks`;
    if (attention?.state === 'permission-limited') return `${attention.name}: limited detail`;
    if (attention) return `${attention.name}: ${attention.state}`;
    return captureHealth.value?.sources.some((source) => source.state === 'receiving')
      ? 'Receiving activity'
      : 'Waiting for activity';
  });

  const selectedSession = computed(
    () => allSessions.value.find((session) => session.key === selectedSessionKey.value) || null,
  );
  // A session that disappears from the day (filter, date or data change) closes the inspector.
  watch(selectedSession, (session) => {
    if (!session && selectedSessionKey.value && summaryLoaded.value) selectedSessionKey.value = '';
  });

  return {
    // navigation
    page,
    settingsSection,
    settingsNavigationRequest,
    connectionsSection,
    reportsSection,
    projectsSection,
    billingSettingsProject,
    usageFocus,
    openSettings,
    openProject,
    openUsageLimits,
    billingProjectRevision,
    project,
    search,
    selectedDate,
    ...workspaceScope,
    pageFilters,filterKey,activityFilters,setActivityFilters,knownProjects,reportFilterOptions,
    selectedSessionKey,
    selectedSession,
    setDate,
    navigate,
    reviewSiteFilter,
    reviewProjectFilter,
    now,
    minute,
    isToday,
    dayStart,
    dayEnd,
    // fetched
    summary,
    summaryLoaded,
    status,
    captureHealth,
    hookStatus,
    websiteProjects,
    usage,
    usageError,
    reportedWork,
    dayReview,
    dayReviewed,
    dayReviewLoading,
    backlogLoading,
    notes,
    pollError,
    reviewRevision,
    // actions
    start,
    refreshSummary: () => pollers.summary.refresh(),
    refreshStatus: () => pollers.status.refresh(),
    refreshHealth: () => pollers.health.refresh(),
    refreshHooks: () => pollers.hooks.refresh(),
    refreshUsage: () => pollers.usage.refresh(),
    refreshWebsiteProjects: loadWebsiteProjects,
    refreshDayReview: loadDayReview,
    openReview,
    refreshNotes: loadNotes,
    applyReviewedSummary,
    markDayReviewed,
    // derived day data
    dayIntervals,
    projects,
    allSessions,
    sessions,
    visibleSessions,
    creditedSessions,
    timelineEligible,
    filteredIntervals,
    visibleReportedWork,
    reportedPlacement,
    runningTimers,
    stopTimer,
    stopTimers,
    reportedSessionKey,
    agentTime,
    mainAgentTime,
    subagentTime,
    agentWallTime,
    agentOverlap,
    humanTime,
    elapsedTime,
    runningCount,
    runs,
    timelineProjects,
    humanBySession,
    issues,
    dayCaptureIssues,
    dayCaptureReasons,
    confidence,
    observedAgentSources,
    appReviewGroups,
    reviewContextPending,
    reviewContextCaptured,
    reviewGroups,
    exportReviewGroups,
    reviewPending,
    reviewCaptured,
    reviewBadge,
    dayGaps,
    sourceProblems,
    outdatedHooks,
    outdatedAgents,
    captureAttention,
    captureLabel,
  };
}

export type Store = ReturnType<typeof createStore>;
let instance: Store | undefined;

/** The dashboard's single shared store. */
export function useStore(): Store {
  if (!instance) instance = effectScope(true).run(createStore)!;
  return instance;
}
