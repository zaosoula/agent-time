<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, watch } from 'vue';
import { Bot, ChevronRight, Clock3, Folder, Globe2, Monitor } from '@lucide/vue';
import type { Interval } from '../capture/events.ts';
import ReportedWorkTimeline from './ReportedWorkTimeline.vue';
import { useStore, type DaySession, type TimelineGroup } from './store.ts';
import { clock, duration, preciseClock } from './format.ts';
import { projectColor, projectDisplay } from './project-identity.ts';
import { workloadAreaPath, workloadChartHeight, workloadChartWidth } from './workload-chart.ts';
import {
  clampTimeRange,
  gridBackground,
  initialTimelineRange,
  minimumTimelineSpan,
  panTimeRange,
  timelineTicks,
  zoomTimeRange,
  type TimeRange,
} from './timeline-viewport.ts';

const emit = defineEmits<{ start: [] }>();
const store = reactive(useStore());

// ---- Visible range ------------------------------------------------------------------------
const viewport = ref<TimeRange | null>(null);
const timelineLimit = ref(40);
watch(
  () => store.selectedDate,
  () => {
    viewport.value = null;
    timelineLimit.value = 40;
    hoveredLoad.value = null;
  },
);

/**
 * The visible range only depends on minute-rounded time, and keeps its previous object when nothing
 * moved, so ticks, bars and workload paths do not re-render every second.
 */
const timelineRange = computed<TimeRange>((previous) => {
  const next = clampTimeRange(
    viewport.value ||
      initialTimelineRange(
        store.dayStart,
        store.dayEnd,
        [
          ...store.filteredIntervals,
          ...store.visibleReportedWork.map((item) => ({ start: item.start, end: item.end })),
        ],
        store.minute,
        store.isToday,
      ),
    store.dayStart,
    store.dayEnd,
  );
  return previous && previous.start === next.start && previous.end === next.end ? previous : next;
});
const timelineStart = computed(() => timelineRange.value.start);
const timelineSpan = computed(() => timelineRange.value.end - timelineRange.value.start);
const daySpan = computed(() => store.dayEnd - store.dayStart);
const ticks = computed(() =>
  timelineTicks(timelineRange.value).filter(
    (tick) =>
      tick.time > timelineRange.value.start + timelineSpan.value * 0.025 &&
      tick.time < timelineRange.value.end - timelineSpan.value * 0.025,
  ),
);
const majorTicks = computed(() => ticks.value.filter((tick) => tick.major));
const grid = computed(() => gridBackground(timelineRange.value));
const gridStyle = computed(() => ({
  '--grid-size': grid.value.size,
  '--grid-position': grid.value.position,
}));
const precise = computed(() => timelineSpan.value <= 5 * 60);
const tickClock = (seconds: number) => (precise.value ? preciseClock(seconds) : clock(seconds));
const rangeClock = (seconds: number) => (seconds >= store.dayEnd ? 'end of day' : tickClock(seconds));
const percent = (time: number) => `${((time - timelineStart.value) / timelineSpan.value) * 100}%`;

const showCursor = computed(
  () =>
    store.isToday &&
    store.now >= timelineStart.value &&
    store.now <= timelineStart.value + timelineSpan.value,
);
const cursorLeft = computed(
  () => `${Math.max(0, Math.min(100, ((store.now - timelineStart.value) / timelineSpan.value) * 100))}%`,
);

function setViewport(range: TimeRange) {
  viewport.value = clampTimeRange(range, store.dayStart, store.dayEnd);
  hoveredLoad.value = null;
}
function usePreset(seconds: number) {
  if (seconds >= daySpan.value) {
    setViewport({ start: store.dayStart, end: store.dayEnd });
    return;
  }
  const focus = viewport.value
    ? timelineStart.value + timelineSpan.value / 2
    : store.isToday
      ? store.now
      : (store.filteredIntervals.at(-1)?.end ?? store.dayStart + 12 * 3600);
  setViewport({ start: focus - seconds / 2, end: focus + seconds / 2 });
}

// ---- Bars ---------------------------------------------------------------------------------
const barStyle = (interval: Pick<Interval, 'start' | 'end'>) => {
  const start = Math.max(interval.start, timelineStart.value),
    end = Math.min(interval.end, timelineStart.value + timelineSpan.value);
  return {
    left: `${Math.max(0, ((start - timelineStart.value) / timelineSpan.value) * 100)}%`,
    width: `${Math.max(0, ((end - start) / timelineSpan.value) * 100)}%`,
  };
};
const overviewStyle = (interval: Pick<Interval, 'start' | 'end'>) => ({
  left: `${((interval.start - store.dayStart) / daySpan.value) * 100}%`,
  width: `${((interval.end - interval.start) / daySpan.value) * 100}%`,
});
const overviewSelectionStyle = computed(() => ({
  left: `${((timelineStart.value - store.dayStart) / daySpan.value) * 100}%`,
  width: `${(timelineSpan.value / daySpan.value) * 100}%`,
}));
const overviewAgents = computed(() => store.timelineProjects.flatMap((group) => group.creditBars));
const overviewHumans = computed(() => store.timelineProjects.flatMap((group) => group.humanBars));
const workloadPath = (group: TimelineGroup) =>
  workloadAreaPath(group.load, timelineStart.value, timelineSpan.value);

// ---- Rows ---------------------------------------------------------------------------------
const expandedRoots = ref<Record<string, boolean>>({});
const collapsedProjects = ref<Record<string, boolean>>({});
const collapsedActivities = ref<Record<string, boolean>>({});
const projectCollapsed = (name: string) => collapsedProjects.value[name] !== false;
/** Reported work for a session row: checkpoints and timers its agent declared. */
const sessionReported = (session: DaySession) =>
  session.child ? [] : store.reportedPlacement.bySession.get(store.reportedSessionKey(session.provider, session.sessionId)) || [];
/** The project's unified reported row; items shown on a visible agent row are left out of it. */
function unifiedReported(group: TimelineGroup) {
  const items = store.reportedPlacement.byProject.get(group.name) || [];
  if (projectCollapsed(group.name)) return items;
  const onRows = new Set(
    visibleRows(group).flatMap((row) => sessionReported(row.session).map((item) => item.id)),
  );
  return items.filter((item) => !onRows.has(item.id));
}
const reportedStyle = (item: { kind: string; start: number; end: number }) =>
  item.kind === 'context' ? { left: percent(item.start), width: '3px' } : barStyle(item);
const reportedTitle = (item: { kind: string; title: string; start: number; end: number; active: boolean }) =>
  item.kind === 'context'
    ? `${tickClock(item.start)} · checkpoint: ${item.title}`
    : `${tickClock(item.start)}–${item.active ? 'now' : tickClock(item.end)} · timer: ${item.title}`;
const activityKey = (projectName: string, kind: 'mac' | 'browser') => `${projectName}:${kind}`;
const activityCollapsed = (projectName: string, kind: 'mac' | 'browser') =>
  collapsedActivities.value[activityKey(projectName, kind)] === true;
function toggleActivity(projectName: string, kind: 'mac' | 'browser') {
  const key = activityKey(projectName, kind);
  collapsedActivities.value[key] = !collapsedActivities.value[key];
}
const visibleTimelineKeys = computed(
  () => new Set(store.timelineEligible.slice(0, timelineLimit.value).map((session) => session.key)),
);
const visibleRows = (group: TimelineGroup) =>
  group.rows.filter(
    (row) =>
      visibleTimelineKeys.value.has(row.session.key) &&
      (!row.parentKey || expandedRoots.value[row.parentKey] === true),
  );
function projectCaption(group: TimelineGroup) {
  const roots = group.sessions.filter((session) => !session.child).length,
    children = group.sessions.length - roots;
  return [
    roots ? `${roots} ${roots === 1 ? 'session' : 'sessions'}` : undefined,
    children ? `${children} ${children === 1 ? 'subagent' : 'subagents'}` : undefined,
    !group.sessions.length && group.macApps.length
      ? `${group.macApps.length} ${group.macApps.length === 1 ? 'app' : 'apps'}`
      : undefined,
    !group.sessions.length && group.websites.length
      ? `${group.websites.length} ${group.websites.length === 1 ? 'website' : 'websites'}`
      : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
}
function select(session: DaySession) {
  store.selectedSessionKey = session.key;
}

// ---- Pointer and wheel input, coalesced to one update per frame ---------------------------
let wheelFrame = 0,
  pendingPan = 0,
  pendingZoom = 0,
  zoomFraction = 0.5;
function applyWheel() {
  wheelFrame = 0;
  let range = timelineRange.value;
  if (pendingPan) range = panTimeRange(range, pendingPan * timelineSpan.value, store.dayStart, store.dayEnd);
  if (pendingZoom) {
    const span = range.end - range.start;
    range = zoomTimeRange(
      range,
      range.start + zoomFraction * span,
      Math.exp(Math.max(-300, Math.min(300, pendingZoom)) * 0.003),
      store.dayStart,
      store.dayEnd,
    );
  }
  pendingPan = 0;
  pendingZoom = 0;
  setViewport(range);
}
function onTimelineWheel(event: WheelEvent) {
  const track = (event.target as Element).closest('.timeline-track, .hour-labels');
  if (!track) return;
  event.preventDefault();
  const bounds = track.getBoundingClientRect();
  if (!bounds.width) return;
  if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) pendingPan += event.deltaX / bounds.width;
  else {
    zoomFraction = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    pendingZoom +=
      event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bounds.height : 1);
  }
  if (!wheelFrame) wheelFrame = requestAnimationFrame(applyWheel);
}

let pinch: { range: TimeRange; anchor: number } | null = null;
function onGestureStart(event: Event) {
  const track = (event.target as Element).closest('.timeline-track, .hour-labels');
  if (!track) return;
  event.preventDefault();
  const bounds = track.getBoundingClientRect(),
    clientX = (event as Event & { clientX?: number }).clientX;
  const fraction =
    clientX === undefined ? 0.5 : Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width));
  pinch = { range: { ...timelineRange.value }, anchor: timelineStart.value + fraction * timelineSpan.value };
}
let pinchFrame = 0,
  pinchScale = 1;
function onGestureChange(event: Event) {
  if (!pinch) return;
  event.preventDefault();
  const scale = (event as Event & { scale?: number }).scale;
  if (!scale || scale <= 0) return;
  pinchScale = scale;
  if (!pinchFrame)
    pinchFrame = requestAnimationFrame(() => {
      pinchFrame = 0;
      if (pinch)
        setViewport(zoomTimeRange(pinch.range, pinch.anchor, 1 / pinchScale, store.dayStart, store.dayEnd));
    });
}
function onGestureEnd() {
  pinch = null;
}

let overviewDrag: { action: 'start' | 'end' | 'move'; x: number; range: TimeRange; width: number } | null =
  null;
let dragFrame = 0,
  dragClientX = 0;
function onOverviewDown(event: PointerEvent) {
  if (event.button !== 0) return;
  const track = event.currentTarget as HTMLElement,
    bounds = track.getBoundingClientRect();
  const action = (event.target as Element).closest<HTMLElement>('[data-range-action]')?.dataset.rangeAction;
  if (!action) {
    const center = store.dayStart + ((event.clientX - bounds.left) / bounds.width) * daySpan.value;
    setViewport({ start: center - timelineSpan.value / 2, end: center + timelineSpan.value / 2 });
    return;
  }
  overviewDrag = {
    action: action as 'start' | 'end' | 'move',
    x: event.clientX,
    range: { ...timelineRange.value },
    width: bounds.width,
  };
  track.setPointerCapture(event.pointerId);
  event.preventDefault();
}
function applyOverviewDrag() {
  dragFrame = 0;
  const drag = overviewDrag;
  if (!drag) return;
  const seconds = ((dragClientX - drag.x) / drag.width) * daySpan.value;
  if (drag.action === 'move') setViewport(panTimeRange(drag.range, seconds, store.dayStart, store.dayEnd));
  else if (drag.action === 'start')
    setViewport({
      start: Math.max(store.dayStart, Math.min(drag.range.end - minimumTimelineSpan, drag.range.start + seconds)),
      end: drag.range.end,
    });
  else
    setViewport({
      start: drag.range.start,
      end: Math.min(store.dayEnd, Math.max(drag.range.start + minimumTimelineSpan, drag.range.end + seconds)),
    });
}
function onOverviewMove(event: PointerEvent) {
  if (!overviewDrag) return;
  dragClientX = event.clientX;
  if (!dragFrame) dragFrame = requestAnimationFrame(applyOverviewDrag);
}
function onOverviewUp() {
  if (dragFrame) {
    cancelAnimationFrame(dragFrame);
    applyOverviewDrag();
  }
  overviewDrag = null;
}
function onHandleKey(event: KeyboardEvent, side: 'start' | 'end') {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  const delta =
    (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 5 : 1) * (timelineSpan.value <= 5 * 60 ? 10 : 60);
  const range = timelineRange.value;
  if (side === 'start')
    setViewport({
      start: Math.max(store.dayStart, Math.min(range.end - minimumTimelineSpan, range.start + delta)),
      end: range.end,
    });
  else
    setViewport({
      start: range.start,
      end: Math.min(store.dayEnd, Math.max(range.start + minimumTimelineSpan, range.end + delta)),
    });
}

const hoveredLoad = ref<{
  project: string;
  left: number;
  tooltipLeft: number;
  time: number;
  roots: number;
  children: number;
  credited: boolean;
  human: boolean;
} | null>(null);
let hoverFrame = 0,
  hoverInput: { x: number; bounds: DOMRect; group: TimelineGroup } | null = null;
function applyHover() {
  hoverFrame = 0;
  const input = hoverInput;
  if (!input) return;
  const { bounds, group } = input;
  const left = Math.max(0, Math.min(bounds.width, input.x - bounds.left));
  const time = timelineStart.value + (left / bounds.width) * timelineSpan.value;
  const load = group.load.find((segment) => segment.start <= time && time < segment.end);
  hoveredLoad.value = {
    project: group.name,
    left,
    tooltipLeft: bounds.width < 236 ? bounds.width / 2 : Math.max(118, Math.min(bounds.width - 118, left)),
    time,
    roots: load?.roots || 0,
    children: load?.children || 0,
    credited: group.creditBars.some((interval) => interval.start <= time && time < interval.end),
    human: group.humanBars.some((interval) => interval.start <= time && time < interval.end),
  };
}
function moveWorkloadHover(event: PointerEvent, group: TimelineGroup) {
  hoverInput = { x: event.clientX, bounds: (event.currentTarget as HTMLElement).getBoundingClientRect(), group };
  if (!hoverFrame) hoverFrame = requestAnimationFrame(applyHover);
}
function leaveWorkload() {
  hoverInput = null;
  if (hoverFrame) cancelAnimationFrame(hoverFrame);
  hoverFrame = 0;
  hoveredLoad.value = null;
}
onUnmounted(() => {
  cancelAnimationFrame(wheelFrame);
  cancelAnimationFrame(pinchFrame);
  cancelAnimationFrame(dragFrame);
  cancelAnimationFrame(hoverFrame);
});
</script>

<template>
  <div
    class="timeline"
    :style="gridStyle"
    @wheel="onTimelineWheel"
    @gesturestart="onGestureStart"
    @gesturechange="onGestureChange"
    @gestureend="onGestureEnd"
  >
    <div class="timeline-zoom">
      <span class="zoom-caption">
        Day overview
        <small>
          {{ rangeClock(timelineStart) }}–{{ rangeClock(timelineStart + timelineSpan) }} · scroll or pinch to
          zoom
        </small>
      </span>
      <div
        class="timeline-overview-track"
        aria-label="Full-day timeline range"
        @pointerdown="onOverviewDown"
        @pointermove="onOverviewMove"
        @pointerup="onOverviewUp"
        @pointercancel="onOverviewUp"
      >
        <span
          v-for="(interval, index) in overviewAgents"
          :key="'a' + index"
          class="overview-bar overview-agent"
          :style="overviewStyle(interval)"
        ></span>
        <span
          v-for="(interval, index) in overviewHumans"
          :key="'h' + index"
          class="overview-bar overview-human"
          :style="overviewStyle(interval)"
        ></span>
        <span
          class="overview-selection"
          :class="{
            narrow: timelineSpan <= 45 * 60,
            atStart: timelineStart === store.dayStart,
            atEnd: timelineStart + timelineSpan === store.dayEnd,
          }"
          data-range-action="move"
          :style="overviewSelectionStyle"
        >
          <span
            class="overview-handle start"
            data-range-action="start"
            role="slider"
            tabindex="0"
            aria-label="Visible range start"
            :aria-valuemin="0"
            :aria-valuemax="Math.round(timelineRange.end - store.dayStart - minimumTimelineSpan)"
            :aria-valuenow="Math.round(timelineRange.start - store.dayStart)"
            :aria-valuetext="rangeClock(timelineRange.start)"
            @keydown="onHandleKey($event, 'start')"
          ></span>
          <span
            class="overview-handle end"
            data-range-action="end"
            role="slider"
            tabindex="0"
            aria-label="Visible range end"
            :aria-valuemin="Math.round(timelineRange.start - store.dayStart + minimumTimelineSpan)"
            :aria-valuemax="Math.round(daySpan)"
            :aria-valuenow="Math.round(timelineRange.end - store.dayStart)"
            :aria-valuetext="rangeClock(timelineRange.end)"
            @keydown="onHandleKey($event, 'end')"
          ></span>
        </span>
      </div>
      <div class="zoom-presets" role="group" aria-label="Zoom">
        <button @click="usePreset(60)">1m</button>
        <button @click="usePreset(900)">15m</button>
        <button @click="usePreset(3600)">1h</button>
        <button @click="usePreset(14400)">4h</button>
        <button @click="usePreset(daySpan)">Day</button>
      </div>
    </div>

    <div class="timeline-header">
      <span>Project and activity</span>
      <div class="hour-labels">
        <span v-for="tick in majorTicks" :key="tick.time" :style="{ left: percent(tick.time) }">
          {{ tickClock(tick.time) }}
        </span>
      </div>
      <span class="time-total">Time</span>
    </div>

    <div class="timeline-body">
      <ReportedWorkTimeline :items="store.reportedPlacement.unplaced" :range="timelineRange" :now="store.minute" />

      <template v-if="!store.summaryLoaded">
        <div v-for="index in 4" :key="index" class="timeline-row skeleton-row" aria-hidden="true">
          <span class="skeleton" style="width: 60%; height: 12px"></span>
          <span class="skeleton" :style="{ width: `${30 + index * 12}%`, height: '12px' }"></span>
          <span class="skeleton" style="width: 40px; height: 12px"></span>
        </div>
        <span class="visually-hidden" role="status">Loading the day…</span>
      </template>

      <div
        v-else-if="!store.timelineProjects.length && !store.visibleReportedWork.length"
        class="empty-state"
      >
        <div class="empty-icon"><Clock3 :size="29" /></div>
        <template v-if="store.search">
          <h2>No matching sessions</h2>
          <p>Try a different search, or clear it to see the whole day.</p>
          <button class="btn" @click="store.search = ''">Clear search</button>
        </template>
        <template v-else-if="store.status?.running || !store.isToday">
          <h2>Nothing recorded {{ store.isToday ? 'yet today' : 'on this day' }}</h2>
          <p>Activity appears here as Agent Time observes your Mac and your agents.</p>
        </template>
        <template v-else>
          <h2>Your work will appear here</h2>
          <p>Start capture to record your Mac activity and agent sessions.</p>
          <button class="btn btn-primary" :disabled="!store.status" @click="emit('start')">Start capture</button>
        </template>
      </div>

      <div v-for="(projectGroup, projectIndex) in store.timelineProjects" :key="projectGroup.name" class="timeline-project">
        <button
          class="project-timeline-row"
          :aria-label="`${projectCollapsed(projectGroup.name) ? 'Expand' : 'Collapse'} ${projectDisplay(projectGroup.name, store.projects)}, ${projectCaption(projectGroup)}`"
          :aria-expanded="!projectCollapsed(projectGroup.name)"
          @click="collapsedProjects[projectGroup.name] = !projectCollapsed(projectGroup.name)"
        >
          <span class="project-timeline-label">
            <ChevronRight :size="13" :class="{ expanded: !projectCollapsed(projectGroup.name) }" />
            <span class="project-symbol" :style="{ color: projectColor(projectGroup.name) }"><Folder :size="15" /></span>
            <span>
              <strong :title="projectGroup.name">{{ projectDisplay(projectGroup.name, store.projects) }}</strong>
              <small>{{ projectCaption(projectGroup) }}</small>
            </span>
          </span>
          <span
            class="timeline-track project-workload"
            @pointermove="moveWorkloadHover($event, projectGroup)"
            @pointerleave="leaveWorkload"
          >
            <svg
              v-if="projectGroup.load.length"
              class="workload-area"
              :viewBox="`0 0 ${workloadChartWidth} ${workloadChartHeight}`"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <path :d="workloadPath(projectGroup)" />
            </svg>
            <span
              v-for="(interval, index) in projectGroup.creditBars"
              :key="'c' + index"
              class="time-block agent-credit"
              :style="barStyle(interval)"
              :title="`${tickClock(interval.start)}–${tickClock(interval.end)} · agent work`"
            ></span>
            <span
              v-for="(interval, index) in projectGroup.humanBars"
              :key="'h' + index"
              class="time-block human"
              :style="barStyle(interval)"
              :title="`${tickClock(interval.start)}–${tickClock(interval.end)} · your activity`"
            ></span>
            <span v-if="projectGroup.peakConcurrent" class="workload-scale" aria-hidden="true">
              <b v-if="projectGroup.peakConcurrent > 1">Peak {{ projectGroup.peakConcurrent }}</b>
              <small>1 agent</small>
            </span>
            <template v-if="hoveredLoad?.project === projectGroup.name">
              <span class="workload-crosshair" :style="{ left: `${hoveredLoad.left}px` }" aria-hidden="true"></span>
              <span
                class="workload-tooltip"
                :class="{ below: projectIndex === 0 }"
                :style="{ left: `${hoveredLoad.tooltipLeft}px` }"
                role="tooltip"
              >
                <strong>
                  {{ tickClock(hoveredLoad.time) }} · {{ hoveredLoad.roots + hoveredLoad.children }}
                  {{ hoveredLoad.roots + hoveredLoad.children === 1 ? 'agent' : 'agents' }} working
                </strong>
                <span>
                  {{ hoveredLoad.roots }} {{ hoveredLoad.roots === 1 ? 'session' : 'sessions' }} ·
                  {{ hoveredLoad.children }} {{ hoveredLoad.children === 1 ? 'subagent' : 'subagents' }}
                </span>
                <span>Counted agent time: {{ hoveredLoad.credited ? 'yes' : 'no' }}</span>
                <span>Your activity: {{ hoveredLoad.human ? 'yes' : 'no' }}</span>
              </span>
            </template>
          </span>
          <span class="time-total">
            <strong>
              {{
                projectGroup.agentSeconds
                  ? `${duration(projectGroup.agentSeconds)} agent`
                  : `${duration(projectGroup.humanSeconds)} you`
              }}
            </strong>
            <small v-if="projectGroup.agentSeconds && projectGroup.humanSeconds">
              {{ duration(projectGroup.humanSeconds) }} you
            </small>
          </span>
        </button>
        <ReportedWorkTimeline
          compact
          :items="unifiedReported(projectGroup)"
          :range="timelineRange"
          :now="store.minute"
        />

        <template v-if="!projectCollapsed(projectGroup.name)">
          <div
            v-for="row in visibleRows(projectGroup)"
            :key="row.session.key"
            class="timeline-row"
            :class="{ focused: store.selectedSessionKey === row.session.key, child: row.session.child }"
            @click="select(row.session)"
          >
            <div class="session-label">
              <button
                v-if="row.childCount"
                class="row-toggle"
                :aria-label="`${expandedRoots[row.session.key] ? 'Hide' : 'Show'} ${row.childCount} subagents`"
                :aria-expanded="expandedRoots[row.session.key] === true"
                @click.stop="expandedRoots[row.session.key] = !expandedRoots[row.session.key]"
              >
                <ChevronRight :size="13" :class="{ expanded: expandedRoots[row.session.key] }" />
              </button>
              <span v-else class="row-toggle-spacer"></span>
              <span class="agent-symbol"><Bot :size="15" /></span>
              <button class="session-open" :aria-label="`View details for ${row.session.title}`" @click.stop="select(row.session)">
                <strong>{{ row.session.title }}</strong>
                <small>
                  {{ row.session.provider || 'Agent' }}
                  <span v-if="row.session.child">· Subagent</span>
                  <span v-else-if="row.session.runId">· Run {{ row.session.runId.slice(-6) }}</span>
                </small>
              </button>
            </div>
            <div class="timeline-track">
              <span
                v-for="(interval, index) in row.creditBars"
                :key="'credit-a' + index"
                class="time-block agent credit"
                :style="barStyle(interval)"
              ></span>
              <span
                v-for="(interval, index) in row.bars"
                :key="'a' + index"
                class="time-block agent"
                :style="barStyle(interval)"
                :title="`${tickClock(interval.start)}–${tickClock(interval.end)} · agent work`"
              ></span>
              <span
                v-for="item in sessionReported(row.session)"
                :key="'r' + item.id"
                class="reported-pin"
                :class="[item.kind, { active: item.active }]"
                :style="reportedStyle(item)"
                :title="reportedTitle(item)"
              ></span>
              <template v-if="!row.session.child">
                <span
                  v-for="(interval, index) in row.childCreditBars"
                  :key="'credit-c' + index"
                  class="time-block subagent credit"
                  :style="barStyle(interval)"
                ></span>
                <span
                  v-for="(interval, index) in row.childBars"
                  :key="'c' + index"
                  class="time-block subagent"
                  :style="barStyle(interval)"
                  :title="`${tickClock(interval.start)}–${tickClock(interval.end)} · subagent`"
                ></span>
              </template>
            </div>
            <span class="time-total"><strong>{{ duration(row.session.seconds) }}</strong></span>
          </div>

          <template v-for="kind in (['mac', 'browser'] as const)" :key="kind">
            <template v-if="kind === 'mac' ? projectGroup.mac.length : projectGroup.browser.length">
              <button
                class="timeline-row activity-row activity-heading"
                :aria-label="`${activityCollapsed(projectGroup.name, kind) ? 'Show' : 'Hide'} ${kind === 'mac' ? 'app' : 'website'} activity in ${projectDisplay(projectGroup.name, store.projects)}`"
                :aria-expanded="!activityCollapsed(projectGroup.name, kind)"
                @click="toggleActivity(projectGroup.name, kind)"
              >
                <span class="session-label">
                  <span class="row-toggle">
                    <ChevronRight :size="13" :class="{ expanded: !activityCollapsed(projectGroup.name, kind) }" />
                  </span>
                  <span class="agent-symbol activity-symbol">
                    <Monitor v-if="kind === 'mac'" :size="15" /><Globe2 v-else :size="15" />
                  </span>
                  <span>
                    <strong>{{ kind === 'mac' ? 'Apps' : 'Websites' }}</strong>
                    <small v-if="kind === 'mac'">
                      {{ projectGroup.macApps.length }} {{ projectGroup.macApps.length === 1 ? 'app' : 'apps' }}
                    </small>
                    <small v-else>
                      {{ projectGroup.websites.length }}
                      {{ projectGroup.websites.length === 1 ? 'website' : 'websites' }}
                    </small>
                  </span>
                </span>
                <span class="timeline-track">
                  <span
                    v-for="(interval, index) in kind === 'mac' ? projectGroup.macBars : projectGroup.browserBars"
                    :key="index"
                    class="time-block human"
                    :style="barStyle(interval)"
                    :title="`${tickClock(interval.start)}–${tickClock(interval.end)} · ${(kind === 'mac' ? interval.foregroundName : interval.browserTitle || interval.browserDomain) || 'Your activity'}`"
                  ></span>
                </span>
                <span class="time-total">
                  <strong>{{ duration(kind === 'mac' ? projectGroup.macSeconds : projectGroup.browserSeconds) }}</strong>
                </span>
              </button>
              <template v-if="!activityCollapsed(projectGroup.name, kind)">
                <div
                  v-for="item in kind === 'mac' ? projectGroup.macApps : projectGroup.websites"
                  :key="item.key"
                  class="timeline-row activity-detail-row"
                >
                  <div class="session-label">
                    <span class="row-toggle-spacer"></span>
                    <span class="agent-symbol activity-symbol">
                      <Monitor v-if="kind === 'mac'" :size="13" /><Globe2 v-else :size="13" />
                    </span>
                    <div>
                      <strong>{{ item.label }}</strong>
                      <small>{{ item.detail }}</small>
                    </div>
                  </div>
                  <div class="timeline-track">
                    <span
                      v-for="(interval, index) in item.bars"
                      :key="index"
                      class="time-block human"
                      :style="barStyle(interval)"
                      :title="`${tickClock(interval.start)}–${tickClock(interval.end)} · ${item.label}`"
                    ></span>
                  </div>
                  <span class="time-total"><strong>{{ duration(item.seconds) }}</strong></span>
                </div>
              </template>
            </template>
          </template>
        </template>
      </div>

      <div
        v-if="
          store.timelineEligible.length > timelineLimit &&
          store.timelineProjects.some((group) => !projectCollapsed(group.name))
        "
        class="more-rows"
      >
        <span>Showing {{ timelineLimit }} of {{ store.timelineEligible.length }} sessions</span>
        <button class="btn btn-sm" @click="timelineLimit += 40">Show 40 more</button>
      </div>

      <div v-if="showCursor" class="timeline-cursor-track" aria-hidden="true">
        <span class="timeline-cursor" :style="{ left: cursorLeft }"><b>Now</b></span>
      </div>
    </div>

    <div class="timeline-legend">
      <span><i class="legend-human"></i>Your activity</span>
      <span><i class="legend-agent"></i>Agent work</span>
      <span><i class="legend-child"></i>Subagents</span>
      <span class="legend-note">Shaded height shows how many agents ran at once</span>
    </div>
  </div>
</template>

<style>
/* Tick grid drawn as two repeating background layers on every track (major, then minor lines). */
.timeline .timeline-track {
  background-image:
    linear-gradient(to right, var(--grid-major) 0 1px, transparent 1px),
    linear-gradient(to right, var(--grid-minor) 0 1px, transparent 1px);
  background-size: var(--grid-size);
  background-position: var(--grid-position);
  background-repeat: repeat-x;
}
.timeline {
  --grid-major: var(--border);
  --grid-minor: color-mix(in srgb, var(--border) 45%, transparent);
}
.timeline-body {
  position: relative;
}
.timeline-body .timeline-cursor-track {
  top: 0;
  bottom: 0;
}
.timeline-row .session-open {
  min-width: 0;
  padding: 0;
  text-align: left;
  color: inherit;
}
.timeline-row .session-open strong,
.timeline-row .session-open small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.timeline-row .agent-symbol:not(.activity-symbol) {
  color: var(--agent);
  background: var(--agent-soft);
}
.skeleton-row {
  cursor: default;
  gap: var(--space-4);
}
</style>
