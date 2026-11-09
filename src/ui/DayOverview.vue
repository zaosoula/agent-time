<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, useId, watch } from 'vue';
import { Activity, ArrowUpRight, Bot, Clock3, GitBranch, Layers3, LoaderCircle, Minus, Plus, RotateCcw, User, X } from '@lucide/vue';
import InfoPopover from './InfoPopover.vue';
import { inactivityGaps, parallelism } from './overview-metrics.ts';
import type { Interval } from '../capture/events.ts';
import { minuteCreditSeconds } from '../capture/correlate.ts';
import { agentLoadSegments, type AgentLoadSegment } from './timeline-groups.ts';
import { panTimeRange, zoomTimeRange, type TimeRange } from './timeline-viewport.ts';
import { useStore, type TimelineGroup } from './store.ts';
import { clock, duration } from './format.ts';
import { projectDisplay } from './project-identity.ts';

/**
 * The shared activity chart and its key figures. It shows the whole day (or the sidebar's project),
 * or one project when the explorer focuses the chart on it.
 */
const props = defineProps<{ focus?: TimelineGroup | null }>();
const emit = defineEmits<{ clearFocus: [] }>();
const store = reactive(useStore());

/** Gaps of this length with no sustained activity are shown as idle and split work periods. */
const idleGap = 30 * 60;
const width = 1000,
  chartHeight = 200,
  humanTop = chartHeight + 14,
  humanHeight = 16,
  height = humanTop + humanHeight;

const work = computed(() => {
  const intervals = store.filteredIntervals as Interval[];
  const grouped = intervals.filter((interval) => interval.state === 'grouped');
  return grouped.length
    ? grouped
    : intervals.filter((interval) => interval.state === 'running' || interval.state === 'turn');
});

/** What the chart and figures describe: the day, or the focused project. */
const scope = computed(() => {
  const group = props.focus;
  if (group) {
    const agents = [...group.agent, ...group.subagent];
    return {
      load: group.load as AgentLoadSegment[],
      human: group.human as Interval[],
      projects: 1,
      sessions: group.sessions.filter((session) => !session.child).length,
      subagents: group.sessions.filter((session) => session.child).length,
      agentSeconds: group.agentSeconds,
      wallSeconds: minuteCreditSeconds(agents.map((interval) => [interval.start, interval.end])),
      humanSeconds: group.humanSeconds,
      peak: group.peakConcurrent,
    };
  }
  const load = agentLoadSegments(
    work.value.filter((interval) => !interval.child),
    work.value.filter((interval) => interval.child),
  );
  return {
    load,
    human: (store.filteredIntervals as Interval[]).filter((interval) => interval.state === 'human'),
    projects: (store.timelineProjects as TimelineGroup[]).filter((group) => group.sessions.length).length,
    sessions: store.creditedSessions.filter((session) => !session.child).length,
    subagents: store.creditedSessions.filter((session) => session.child).length,
    agentSeconds: store.agentTime,
    wallSeconds: store.agentWallTime,
    humanSeconds: store.humanTime,
    peak: Math.max(0, ...load.map((step) => step.roots + step.children)),
  };
});
const ratio = computed(() => (scope.value.humanSeconds > 0 ? scope.value.agentSeconds / scope.value.humanSeconds : null));
const concurrency = computed(() => parallelism(scope.value.load));
const figures = computed(() => [
  { label: 'Sessions', value: scope.value.sessions, detail: `${scope.value.projects} ${scope.value.projects === 1 ? 'project' : 'projects'}`, icon: Layers3 },
  { label: 'Subagents', value: scope.value.subagents, detail: 'Delegated executions', icon: GitBranch },
  { label: 'Peak concurrency', value: scope.value.peak, detail: 'Agents working at once', icon: Activity },
  { label: 'Agent time', value: duration(scope.value.agentSeconds), detail: 'All executions added up', icon: Bot, kind: 'agent' },
  { label: 'Your activity', value: duration(scope.value.humanSeconds), detail: 'Estimated active Mac time', icon: User, kind: 'human' },
  { label: 'Agent / human', value: ratio.value === null ? '—' : `${ratio.value.toFixed(ratio.value >= 10 ? 1 : 2)}×`, detail: 'Time ratio, not productivity', icon: ArrowUpRight, kind: 'agent' },
]);
const plot = ref<HTMLElement | null>(null);
const plotWidth = ref(900);
const svgId = useId();
let resizeObserver: ResizeObserver | undefined;
onMounted(() => {
  if (!plot.value) return;
  resizeObserver = new ResizeObserver(([entry]) => {
    if (entry) plotWidth.value = entry.contentRect.width;
  });
  resizeObserver.observe(plot.value);
});
onUnmounted(() => resizeObserver?.disconnect());

/**
 * Work periods. The day is cut into 10-minute slots; a slot is busy when it holds at least two
 * minutes of activity, yours or an agent's, so brief blips (a scheduled agent, a glance at the
 * Mac) do not join periods. Busy slots less than `idleGap` apart form one period.
 */
const slot = 600,
  busyThreshold = 120;
const periods = computed(() => {
  const busy = new Map<number, number>();
  const spans = [
    ...scope.value.load.map((step) => [step.start, step.end] as const),
    ...scope.value.human.map((interval) => [interval.start, interval.end] as const),
  ]
    .map(([start, end]) => [Math.max(start, store.dayStart), Math.min(end, store.dayEnd)] as const)
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);
  // Union first so overlapping agents are not counted several times in one slot.
  const union: Array<[number, number]> = [];
  for (const [start, end] of spans) {
    const last = union.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else union.push([start, end]);
  }
  for (const [start, end] of union)
    for (let at = start; at < end; ) {
      const index = Math.floor((at - store.dayStart) / slot),
        until = Math.min(end, store.dayStart + (index + 1) * slot);
      busy.set(index, (busy.get(index) || 0) + until - at);
      at = until;
    }
  const result: Array<{ start: number; end: number }> = [];
  for (const index of [...busy.keys()].sort((a, b) => a - b)) {
    if ((busy.get(index) || 0) < busyThreshold) continue;
    const start = store.dayStart + index * slot,
      end = Math.min(store.dayEnd, start + slot),
      last = result.at(-1);
    if (last && start - last.end < idleGap) last.end = end;
    else result.push({ start, end });
  }
  return result;
});
const idle = computed(() => inactivityGaps([...scope.value.load, ...scope.value.human]));

const showHuman = ref(true);
const period = ref<number | null>(null);
/** A range set by zooming or panning; null follows the period chips. */
const manual = ref<TimeRange | null>(null);
watch(
  () => [store.selectedDate, store.project, props.focus?.name],
  () => {
    period.value = null;
    manual.value = null;
  },
);
const automatic = computed<TimeRange>(() => {
  const chosen = period.value === null ? undefined : periods.value[period.value];
  if (chosen) {
    const pad = Math.max(300, (chosen.end - chosen.start) * 0.04);
    return { start: Math.max(store.dayStart, chosen.start - pad), end: Math.min(store.dayEnd, chosen.end + pad) };
  }
  const first = periods.value[0],
    last = periods.value.at(-1);
  // The whole day, trimmed to the hours with activity so the chart is not mostly empty.
  if (!first || !last) return { start: store.dayStart, end: store.dayEnd };
  const hour = 3600;
  return {
    start: Math.max(store.dayStart, Math.floor(first.start / hour) * hour),
    end: Math.min(store.dayEnd, Math.ceil(Math.max(last.end, store.isToday ? store.minute : last.end) / hour) * hour),
  };
});
const range = computed(() => manual.value || automatic.value);
const span = computed(() => Math.max(60, range.value.end - range.value.start));
const x = (time: number) =>
  ((Math.min(Math.max(time, range.value.start), range.value.end) - range.value.start) / span.value) * width;
const scale = computed(() => Math.max(2, Math.ceil(scope.value.peak / 2) * 2));
const y = (count: number) => chartHeight - (count / scale.value) * (chartHeight - 8);

const areaPath = computed(() => {
  const steps = scope.value.load.filter((step) => step.end > range.value.start && step.start < range.value.end);
  if (!steps.length) return '';
  let path = '',
    cursor: number | undefined;
  for (const step of steps) {
    const total = step.roots + step.children,
      from = x(step.start),
      to = x(step.end);
    if (cursor === undefined || from > cursor + 0.01)
      path += `${cursor === undefined ? '' : `L${cursor},${chartHeight} `}M${from},${chartHeight} `;
    path += `L${from},${y(total)} L${to},${y(total)} `;
    cursor = to;
  }
  return `${path}L${cursor},${chartHeight} Z`;
});
const humanBars = computed(() =>
  scope.value.human.filter((interval) => interval.end > range.value.start && interval.start < range.value.end),
);
const ticks = computed(() => {
  const budget = Math.max(2, Math.floor(plotWidth.value / 72));
  const step = [300, 900, 1800, 3600, 7200, 10800, 14400, 21600, 43200].find((value) => value >= span.value / budget) || 43200;
  const result: number[] = [];
  for (let time = Math.ceil(range.value.start / step) * step; time <= range.value.end; time += step) result.push(time);
  return result;
});
const yTicks = computed(() => {
  const step = scale.value <= 6 ? 1 : scale.value <= 12 ? 2 : Math.ceil(scale.value / 6);
  const result: number[] = [];
  for (let value = 0; value <= scale.value; value += step) result.push(value);
  return result;
});
const peakStep = computed(() => scope.value.load.find((step) =>
  step.roots + step.children === scope.value.peak && step.end > range.value.start && step.start < range.value.end,
));

// ---- Zoom and pan: pinch or ctrl+wheel zooms at the pointer, horizontal or shift+wheel pans ----
function zoomAt(anchor: number, factor: number) {
  manual.value = zoomTimeRange(range.value, anchor, factor, store.dayStart, store.dayEnd);
}
function pan(seconds: number) {
  manual.value = panTimeRange(range.value, seconds, store.dayStart, store.dayEnd);
}
function wheel(event: WheelEvent) {
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const at = range.value.start + Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)) * span.value;
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault();
    zoomAt(at, Math.exp(event.deltaY * 0.01));
  } else if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
    event.preventDefault();
    pan(((event.shiftKey ? event.deltaY : event.deltaX) / box.width) * span.value);
  }
}
function keyboard(event: KeyboardEvent) {
  const middle = (range.value.start + range.value.end) / 2;
  if (event.key === '+' || event.key === '=') zoomAt(middle, 0.7);
  else if (event.key === '-' || event.key === '_') zoomAt(middle, 1 / 0.7);
  else if (event.key === 'ArrowLeft') pan(-span.value * 0.15);
  else if (event.key === 'ArrowRight') pan(span.value * 0.15);
  else if (event.key === '0' || event.key === 'Escape') resetView();
  else return;
  event.preventDefault();
}
function resetView() {
  manual.value = null;
  period.value = null;
}
function choosePeriod(index: number | null) {
  manual.value = null;
  period.value = index;
}

const hover = ref<{ left: number; time: number; roots: number; children: number; human: boolean } | null>(null);
function move(event: PointerEvent) {
  const box = (event.currentTarget as SVGElement).getBoundingClientRect();
  const ratioX = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
  const time = range.value.start + ratioX * span.value;
  const step = scope.value.load.find((item) => item.start <= time && item.end > time);
  hover.value = {
    left: ratioX * 100,
    time,
    roots: step?.roots || 0,
    children: step?.children || 0,
    human: scope.value.human.some((interval) => interval.start <= time && interval.end > time),
  };
}
</script>

<template>
  <section class="overview" aria-label="Day overview">
    <div class="overview-cards">
      <div v-for="figure in figures" :key="figure.label" :class="['overview-card', figure.kind]">
        <span class="figure-label"><component :is="figure.icon" :size="15" />{{ figure.label }}</span>
        <strong v-if="store.summaryLoaded">{{ figure.value }}</strong>
        <strong v-else><span class="skeleton figure-skeleton" aria-label="Loading"></span></strong>
        <small>{{ figure.detail }}</small>
      </div>
    </div>

    <div class="overview-chart">
      <div class="chart-head">
        <div class="chart-title">
          <span class="chart-symbol"><Activity :size="21" /></span>
          <div><h2>Activity timeline</h2><p>One shared clock for your work and your agents.</p></div>
        </div>
        <span v-if="focus" class="focus-chip">
          <strong>{{ projectDisplay(focus.name, store.projects) }}</strong>
          <button class="icon-button" aria-label="Show all projects again" @click="emit('clearFocus')"><X :size="13" /></button>
        </span>
        <span class="range-label"><Clock3 :size="13" />{{ clock(range.start) }}–{{ range.end === store.dayEnd ? '24:00' : clock(range.end) }}</span>
      </div>
      <div class="chart-toolbar">
        <div class="chart-legend">
          <span><i class="swatch agent"></i>Agents working</span>
          <label class="human-toggle"><input v-model="showHuman" type="checkbox" /><i class="swatch human"></i>Your activity</label>
          <span v-if="idle.length"><i class="swatch idle"></i>Inactivity</span>
        </div>
        <div class="zoom-controls" role="group" aria-label="Timeline zoom">
          <button class="icon-button" aria-label="Zoom out" :disabled="span >= store.dayEnd - store.dayStart" @click="zoomAt((range.start + range.end) / 2, 1 / 0.7)"><Minus :size="14" /></button>
          <button class="icon-button" aria-label="Reset timeline zoom" @click="resetView"><RotateCcw :size="13" /></button>
          <button class="icon-button" aria-label="Zoom in" :disabled="span <= 300" @click="zoomAt((range.start + range.end) / 2, 0.7)"><Plus :size="14" /></button>
        </div>
      </div>
      <div class="chart-body">
        <div class="y-axis" :style="{ height: `calc(var(--plot-height) * ${chartHeight / height})` }" aria-hidden="true">
          <span v-for="value in yTicks" :key="value" :style="{ bottom: `${(value / scale) * ((chartHeight - 8) / chartHeight) * 100}%` }">{{ value }}</span>
        </div>
        <div ref="plot" class="chart-plot" tabindex="0" role="group"
          aria-label="Activity timeline. Plus and minus zoom, arrow keys pan, zero resets."
          @wheel="wheel" @keydown="keyboard">
          <svg :viewBox="`0 0 ${width} ${height}`" preserveAspectRatio="none" role="img"
            :aria-label="`Agent concurrency, peak ${scope.peak} agents at once`" @pointermove="move" @pointerleave="hover = null">
            <defs>
              <linearGradient :id="`${svgId}-area`" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="var(--slate-light)" stop-opacity="0.95" />
                <stop offset="100%" stop-color="var(--agent-chart)" stop-opacity="0.55" />
              </linearGradient>
              <pattern :id="`${svgId}-idle`" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <line x1="0" y1="0" x2="0" y2="9" stroke="var(--border-strong)" stroke-width="1" />
              </pattern>
            </defs>
            <line v-for="value in yTicks" :key="'g' + value" x1="0" :x2="width" :y1="y(value)" :y2="y(value)" class="grid" />
            <line v-for="time in ticks" :key="'t' + time" :x1="x(time)" :x2="x(time)" y1="0" :y2="height" class="grid vertical" />
            <rect v-for="gap in idle" :key="'i' + gap.start" :x="x(gap.start)" y="0"
              :width="Math.max(0, x(gap.end) - x(gap.start))" :height="chartHeight" :fill="`url(#${svgId}-idle)`" class="idle" />
            <path v-if="areaPath" :d="areaPath" :fill="`url(#${svgId}-area)`" class="agent-area" />
            <line x1="0" :x2="width" :y1="humanTop - 7" :y2="humanTop - 7" class="baseline" />
            <template v-if="showHuman">
              <rect v-for="(interval, index) in humanBars" :key="'h' + index" :x="x(interval.start)" :y="humanTop"
                :width="Math.max(1.5, x(interval.end) - x(interval.start))" :height="humanHeight" rx="1" class="human-mark" />
            </template>
            <circle v-if="peakStep && scope.peak" :cx="x(Math.max(range.start, peakStep.start))" :cy="y(scope.peak)" r="3.5" class="peak-point" />
            <line v-if="store.isToday && store.minute > range.start && store.minute < range.end" :x1="x(store.minute)" :x2="x(store.minute)" y1="0" :y2="height" class="now" />
            <line v-if="hover" :x1="x(hover.time)" :x2="x(hover.time)" y1="0" :y2="height" class="hover-line" />
          </svg>
          <div class="x-axis" aria-hidden="true">
            <span v-for="time in ticks" :key="time" :style="{ left: `${(x(time) / width) * 100}%` }">{{ clock(time) }}</span>
          </div>
          <div v-if="hover" class="chart-hover" :style="{ left: `clamp(76px, ${hover.left}%, calc(100% - 76px))` }">
            <strong>{{ clock(hover.time) }}</strong>
            <span>{{ hover.roots + hover.children }} {{ hover.roots + hover.children === 1 ? 'agent' : 'agents' }} working</span>
            <span v-if="hover.children">{{ hover.roots }} sessions · {{ hover.children }} subagents</span>
            <span>{{ hover.human ? 'You were active' : 'No human activity recorded' }}</span>
          </div>
          <p v-if="!store.summaryLoaded" class="chart-empty chart-loading" role="status">
            <span><LoaderCircle :size="15" class="spin" />Loading activity…</span>
          </p>
          <p v-else-if="!areaPath && !humanBars.length" class="chart-empty">No activity recorded in this range.</p>
        </div>
      </div>
      <div class="chart-bottom">
        <div v-if="periods.length > 1" class="period-controls" role="group" aria-label="Work period">
          <button :class="{ active: period === null && !manual }" :aria-pressed="period === null && !manual" @click="choosePeriod(null)">All periods</button>
          <button v-for="(item, index) in periods.slice(0, 8)" :key="item.start" :class="{ active: period === index && !manual }"
            :aria-pressed="period === index && !manual" :title="`${clock(item.start)}–${clock(item.end)}`" @click="choosePeriod(index)">{{ clock(item.start) }}–{{ clock(item.end) }}</button>
        </div>
        <p class="chart-hint">Pinch or ⌘-scroll to zoom · Shift-scroll to pan</p>
      </div>
    </div>

    <div class="overview-reading">
      <div class="parallelism">
        <span class="parallel-symbol"><Layers3 :size="20" /></span>
        <div><strong>{{ concurrency.average === null ? 'No agent execution yet' : `${concurrency.average.toFixed(1)}× parallelism` }}</strong>
          <p>{{ concurrency.average === null ? 'Recorded executions will appear in the timeline.' : 'Average agents working during active execution. Idle gaps excluded.' }}</p></div>
      </div>
      <InfoPopover label="How these times are measured">
        <template #trigger><span class="measurement-help">How to read these times</span></template>
        <h3>Different views of the same day</h3>
        <p><strong>Agent time</strong> adds each agent’s measured execution, including agents working in parallel.</p>
        <p><strong>Active elapsed time</strong> counts periods with any agent working once. Here: {{ duration(scope.wallSeconds) }}.</p>
        <p><strong>Your activity</strong> estimates active time on your Mac. The agent / human ratio compares recorded time; it does not measure productivity.</p>
        <p><strong>Parallelism</strong> is duration-weighted concurrency during recorded agent execution, excluding inactive gaps.</p>
      </InfoPopover>
    </div>
  </section>
</template>

<style scoped>
.overview { display: grid; gap: 14px; margin-bottom: 28px; }
.overview-cards { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; }
.overview-card { display: flex; flex-direction: column; gap: 10px; padding: 16px 14px; border: 1px solid var(--border); border-radius: 12px; background: var(--panel); min-width: 0; }
.figure-label { display: flex; align-items: center; gap: 7px; font-size: var(--text-sm); color: var(--muted); }
.figure-label svg { flex: none; color: var(--agent); }
.overview-card strong { font-size: clamp(22px, 2.2vw, 30px); font-weight: 650; letter-spacing: -0.8px; font-variant-numeric: tabular-nums; line-height: 1.1; }
.overview-card.agent strong { color: var(--agent); }
.overview-card.human strong, .overview-card.human svg { color: var(--human); }
.overview-card small { font-size: var(--text-xs); color: var(--muted); line-height: 1.4; }
.overview-chart { padding: 22px 24px 14px; border: 1px solid var(--border-strong); border-radius: 16px; background: var(--panel); }
.chart-head, .chart-title, .chart-toolbar, .chart-legend, .chart-bottom { display: flex; align-items: center; gap: 14px; }
.chart-head { flex-wrap: wrap; }
.chart-title { gap: 12px; margin-right: auto; }
.chart-symbol, .parallel-symbol { display: grid; place-items: center; width: 40px; height: 40px; flex: none; border-radius: 11px; background: var(--agent-soft); color: var(--agent); }
.chart-head h2 { margin: 0; font-size: 18px; font-weight: 650; letter-spacing: -0.3px; }
.chart-head p { margin: 4px 0 0; font-size: var(--text-sm); color: var(--muted); }
.range-label { display: inline-flex; align-items: center; gap: 6px; font-size: var(--text-xs); color: var(--muted); font-variant-numeric: tabular-nums; }
.focus-chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 4px 3px 10px; border: 1px solid var(--agent); border-radius: 999px; font-size: var(--text-sm); color: var(--agent); max-width: 100%; }
.focus-chip strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chart-toolbar { justify-content: space-between; margin: 20px 0 18px; flex-wrap: wrap; gap: 10px; }
.chart-legend { flex-wrap: wrap; gap: 18px; font-size: var(--text-xs); color: var(--muted); }
.chart-legend span, .human-toggle { display: inline-flex; align-items: center; gap: 7px; }
.human-toggle { cursor: pointer; }
.human-toggle input { width: 13px; height: 13px; margin: 0; accent-color: var(--human); }
.swatch { display: inline-block; width: 11px; height: 11px; border-radius: 3px; }
.swatch.agent { background: var(--agent-chart); }
.swatch.human { width: 4px; background: var(--human-chart); }
.swatch.idle { border: 1px solid var(--border); background: repeating-linear-gradient(45deg, var(--border) 0 1px, transparent 1px 5px); }
.zoom-controls { display: flex; align-items: center; padding: 2px; border: 1px solid var(--border); border-radius: 8px; }
.zoom-controls .icon-button { width: 28px; height: 26px; color: var(--muted); }
.chart-body { --plot-height: 260px; display: grid; grid-template-columns: 24px minmax(0, 1fr); gap: 10px; }
.y-axis { position: relative; }
.y-axis span { position: absolute; right: 0; transform: translateY(50%); font-size: var(--text-xs); color: var(--muted); font-variant-numeric: tabular-nums; }
.chart-plot { position: relative; padding-bottom: 26px; border-radius: 6px; outline-offset: 4px; min-width: 0; }
.chart-plot > svg { display: block; width: 100%; height: var(--plot-height); overflow: visible; }
.grid { stroke: var(--border); stroke-dasharray: 3 5; vector-effect: non-scaling-stroke; }
.grid.vertical { opacity: 0.6; }
.idle { opacity: 0.35; }
.agent-area { stroke: var(--agent-chart); stroke-width: 1; vector-effect: non-scaling-stroke; }
.baseline { stroke: var(--border); vector-effect: non-scaling-stroke; }
.human-mark { fill: var(--human-chart); }
.peak-point { fill: var(--slate-light); stroke: var(--agent); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.now { stroke: var(--now); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.hover-line { stroke: var(--agent); stroke-dasharray: 3 3; vector-effect: non-scaling-stroke; }
.x-axis { position: absolute; left: 0; right: 0; bottom: 0; height: 18px; }
.x-axis span { position: absolute; transform: translateX(-50%); font-size: var(--text-xs); color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.x-axis span:first-child { transform: none; }
.x-axis span:last-child { transform: translateX(-100%); }
.chart-hover { position: absolute; top: 8px; transform: translateX(-50%); display: flex; flex-direction: column; gap: 3px; padding: 10px 12px; border: 1px solid var(--border-strong); border-radius: 9px; background: var(--panel-raised); font-size: var(--text-xs); pointer-events: none; width: 152px; box-shadow: var(--shadow-popover); }
.chart-hover span { color: var(--muted); }
.chart-empty { position: absolute; inset: 0 0 26px; display: grid; place-items: center; margin: 0; color: var(--muted); font-size: var(--text-sm); }
.chart-loading span { display: inline-flex; align-items: center; gap: 8px; }
.chart-loading svg { flex: none; width: 15px; height: 15px; }
.spin { animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
.figure-skeleton { width: 64px; height: 30px; }
.chart-bottom { justify-content: space-between; flex-wrap: wrap; margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--border); }
.period-controls { display: flex; gap: 4px; flex-wrap: wrap; }
.period-controls button { padding: 5px 9px; border-radius: 6px; font-size: var(--text-xs); color: var(--muted); font-variant-numeric: tabular-nums; }
.period-controls button:hover { background: var(--hover); }
.period-controls button.active { background: var(--agent-soft); color: var(--agent); }
.chart-hint { margin: 0; font-size: var(--text-xs); color: var(--muted); }
.overview-reading { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 4px 4px 0; }
.parallelism { display: flex; align-items: center; gap: 12px; }
.parallel-symbol { width: 36px; height: 36px; }
.parallelism strong { color: var(--agent); font-size: var(--text-md); }
.parallelism p { margin: 3px 0 0; color: var(--muted); font-size: var(--text-xs); }
.measurement-help { color: var(--muted); font-size: var(--text-xs); white-space: nowrap; }
.overview-reading :deep(.info-trigger) { width: auto; height: auto; padding: 6px 8px; border-radius: 6px; text-align: left; }
@media (max-width: 1200px) { .overview-cards { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 640px) {
  .overview { gap: 12px; }
  .overview-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .overview-card { padding: 13px; gap: 8px; }
  .overview-card strong { font-size: 26px; }
  .overview-chart { padding: 16px 14px 12px; border-radius: 13px; }
  .chart-title { gap: 9px; }
  .chart-symbol { width: 33px; height: 33px; }
  .chart-head h2 { font-size: 16px; }
  .chart-head p { font-size: 11px; }
  .range-label { margin-left: 42px; }
  .chart-legend { gap: 10px; }
  .chart-toolbar { margin-top: 16px; }
  .chart-body { --plot-height: 230px; gap: 7px; grid-template-columns: 18px minmax(0, 1fr); }
  .chart-hint { display: none; }
  .chart-bottom:has(> .chart-hint:only-child) { display: none; }
  .overview-reading { align-items: flex-start; flex-direction: column; gap: 10px; }
  .measurement-help { white-space: normal; }
}
</style>
