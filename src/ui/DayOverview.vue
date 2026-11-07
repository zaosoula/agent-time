<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import type { Interval } from '../capture/events.ts';
import { agentLoadSegments } from './timeline-groups.ts';
import { useStore } from './store.ts';
import { clock, duration } from './format.ts';

/**
 * Day overview: headline numbers and a chart of how many agents worked at once,
 * with your own activity beneath it. It follows the sidebar's project filter.
 */
const store = reactive(useStore());

/** Gaps longer than this with no activity at all are shown as idle and split work periods. */
const idleGap = 30 * 60;
const width = 1000,
  chartHeight = 150,
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
const human = computed(() => (store.filteredIntervals as Interval[]).filter((interval) => interval.state === 'human'));
const load = computed(() =>
  agentLoadSegments(
    work.value.filter((interval) => !interval.child),
    work.value.filter((interval) => interval.child),
  ),
);
const peak = computed(() => Math.max(0, ...load.value.map((step) => step.roots + step.children)));
const sessions = computed(() => store.creditedSessions.filter((session) => !session.child).length);
const subagents = computed(() => store.creditedSessions.filter((session) => session.child).length);
const ratio = computed(() => (store.humanTime > 0 ? store.agentTime / store.humanTime : null));

/**
 * Work periods. The day is cut into 10-minute slots; a slot is busy when it holds at least two
 * minutes of activity, yours or an agent's, so brief blips (a scheduled agent, a glance at the
 * Mac) do not join periods. Busy slots less than `idleGap` apart form one period.
 */
const slot = 600,
  busyThreshold = 120;
const periods = computed(() => {
  const busy = new Map<number, number>();
  const spans = [...work.value, ...human.value]
    .map((interval) => [Math.max(interval.start, store.dayStart), Math.min(interval.end, store.dayEnd)] as const)
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
        slotEnd = store.dayStart + (index + 1) * slot,
        until = Math.min(end, slotEnd);
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
const idle = computed(() =>
  periods.value.slice(1).map((period, index) => ({ start: periods.value[index]!.end, end: period.start })),
);

const showHuman = ref(true);
const focus = ref<number | null>(null);
watch(
  () => [store.selectedDate, store.project],
  () => (focus.value = null),
);
const range = computed(() => {
  const period = focus.value === null ? undefined : periods.value[focus.value];
  if (period) {
    const pad = Math.max(300, (period.end - period.start) * 0.04);
    return { start: Math.max(store.dayStart, period.start - pad), end: Math.min(store.dayEnd, period.end + pad) };
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
const span = computed(() => Math.max(60, range.value.end - range.value.start));
const x = (time: number) => ((Math.min(Math.max(time, range.value.start), range.value.end) - range.value.start) / span.value) * width;
const scale = computed(() => Math.max(2, Math.ceil(peak.value / 2) * 2));
const y = (count: number) => chartHeight - (count / scale.value) * (chartHeight - 8);

const areaPath = computed(() => {
  const steps = load.value.filter((step) => step.end > range.value.start && step.start < range.value.end);
  if (!steps.length) return '';
  let path = '',
    cursor: number | undefined;
  for (const step of steps) {
    const total = step.roots + step.children,
      from = x(step.start),
      to = x(step.end);
    if (cursor === undefined || from > cursor + 0.01) path += `${cursor === undefined ? '' : `L${cursor},${chartHeight} `}M${from},${chartHeight} `;
    path += `L${from},${y(total)} L${to},${y(total)} `;
    cursor = to;
  }
  return `${path}L${cursor},${chartHeight} Z`;
});
const ticks = computed(() => {
  const hours = span.value / 3600,
    step = hours <= 2 ? 900 : hours <= 6 ? 3600 : hours <= 14 ? 7200 : 10800;
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

const hover = ref<{ left: number; time: number; roots: number; children: number; human: boolean } | null>(null);
function move(event: PointerEvent) {
  const box = (event.currentTarget as SVGElement).getBoundingClientRect();
  const ratioX = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
  const time = range.value.start + ratioX * span.value;
  const step = load.value.find((item) => item.start <= time && item.end > time);
  hover.value = {
    left: ratioX * 100,
    time,
    roots: step?.roots || 0,
    children: step?.children || 0,
    human: human.value.some((interval) => interval.start <= time && interval.end > time),
  };
}
</script>

<template>
  <section class="overview" aria-label="Day overview">
    <div class="overview-cards">
      <div class="overview-card">
        <span>Sessions</span>
        <strong>{{ store.summaryLoaded ? sessions : '–' }}</strong>
      </div>
      <div class="overview-card">
        <span>Subagents</span>
        <strong class="agent">{{ store.summaryLoaded ? subagents : '–' }}</strong>
      </div>
      <div class="overview-card">
        <span>Peak concurrency</span>
        <strong>{{ store.summaryLoaded ? peak : '–' }}</strong>
        <small v-if="peak">agents at once</small>
      </div>
      <div class="overview-card">
        <span>Cumulative agent time</span>
        <strong class="agent">{{ store.summaryLoaded ? duration(store.agentTime) : '–' }}</strong>
        <small v-if="store.agentTime"
          >{{ duration(store.agentWallTime) }} wall clock · {{ duration(store.subagentTime) }} subagents</small
        >
      </div>
      <div class="overview-card">
        <span>Your activity</span>
        <strong class="human">{{ store.summaryLoaded ? duration(store.humanTime) : '–' }}</strong>
        <small v-if="store.elapsedTime">{{ duration(store.elapsedTime) }} elapsed with any activity</small>
      </div>
      <div class="overview-card">
        <span>Agents / you</span>
        <strong class="agent">{{ ratio === null ? '–' : `${ratio.toFixed(ratio >= 10 ? 1 : 2)}×` }}</strong>
        <small v-if="ratio !== null">cumulative agent time per hour of yours</small>
      </div>
    </div>

    <div class="overview-chart">
      <div class="chart-head">
        <div>
          <h2>Agent concurrency</h2>
          <p>Agents working at once, and your own activity, across the day.</p>
        </div>
        <div class="chart-controls">
          <div v-if="periods.length > 1" class="segmented" role="group" aria-label="Work period">
            <button :class="{ active: focus === null }" @click="focus = null">All</button>
            <button
              v-for="(period, index) in periods.slice(0, 8)"
              :key="period.start"
              :class="{ active: focus === index }"
              :title="`${clock(period.start)}–${clock(period.end)}`"
              @click="focus = index"
            >
              {{ clock(period.start) }}
            </button>
          </div>
          <label class="human-toggle"><input v-model="showHuman" type="checkbox" /> You</label>
        </div>
      </div>
      <div class="chart-legend">
        <span><i class="swatch agent"></i>Agents working</span>
        <span v-if="showHuman"><i class="swatch human"></i>Your activity</span>
        <span v-if="idle.length"><i class="swatch idle"></i>Idle over 30 min</span>
      </div>
      <div class="chart-body">
        <div class="y-axis" :style="{ height: `${(chartHeight / height) * 100}%` }">
          <span v-for="value in yTicks" :key="value" :style="{ bottom: `${(value / scale) * ((chartHeight - 8) / chartHeight) * 100}%` }">{{
            value
          }}</span>
        </div>
        <div class="chart-plot">
          <svg
            :viewBox="`0 0 ${width} ${height}`"
            preserveAspectRatio="none"
            role="img"
            :aria-label="`Agent concurrency, peak ${peak} agents at once`"
            @pointermove="move"
            @pointerleave="hover = null"
          >
            <defs>
              <linearGradient id="agent-area" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="var(--agent)" stop-opacity="0.95" />
                <stop offset="100%" stop-color="var(--agent)" stop-opacity="0.55" />
              </linearGradient>
              <pattern id="idle-hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <line x1="0" y1="0" x2="0" y2="8" stroke="var(--border-strong, var(--border))" stroke-width="2" />
              </pattern>
            </defs>
            <line
              v-for="value in yTicks"
              :key="'g' + value"
              x1="0"
              :x2="width"
              :y1="y(value)"
              :y2="y(value)"
              class="grid"
            />
            <rect
              v-for="gap in idle"
              :key="'i' + gap.start"
              :x="x(gap.start)"
              y="0"
              :width="Math.max(0, x(gap.end) - x(gap.start))"
              :height="chartHeight"
              fill="url(#idle-hatch)"
              class="idle"
            />
            <path v-if="areaPath" :d="areaPath" fill="url(#agent-area)" />
            <template v-if="showHuman">
              <rect
                v-for="(interval, index) in human"
                :key="'h' + index"
                :x="x(interval.start)"
                :y="humanTop"
                :width="Math.max(1.5, x(interval.end) - x(interval.start))"
                :height="humanHeight"
                class="human-mark"
              />
            </template>
            <line
              v-if="store.isToday && store.minute > range.start && store.minute < range.end"
              :x1="x(store.minute)"
              :x2="x(store.minute)"
              y1="0"
              :y2="height"
              class="now"
            />
          </svg>
          <div class="x-axis">
            <span v-for="time in ticks" :key="time" :style="{ left: `${(x(time) / width) * 100}%` }">{{ clock(time) }}</span>
          </div>
          <div v-if="hover" class="chart-hover" :style="{ left: `${hover.left}%` }">
            <strong>{{ clock(hover.time) }}</strong>
            <span>{{ hover.roots + hover.children }} {{ hover.roots + hover.children === 1 ? 'agent' : 'agents' }}</span>
            <span v-if="hover.children">{{ hover.roots }} sessions · {{ hover.children }} subagents</span>
            <span>{{ hover.human ? 'You were active' : 'You were away' }}</span>
          </div>
          <p v-if="store.summaryLoaded && !areaPath && !human.length" class="chart-empty">No activity recorded on this day.</p>
        </div>
      </div>
      <p class="chart-hint">Hover the chart to see who was working. Pick a work period to zoom in.</p>
    </div>
  </section>
</template>

<style scoped>
.overview {
  display: grid;
  gap: var(--space-4);
  margin-bottom: var(--space-5);
}
.overview-cards {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-3);
}
.overview-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: var(--space-4);
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--panel);
  min-width: 0;
}
.overview-card > span {
  font-size: var(--text-sm);
  color: var(--muted);
}
.overview-card strong {
  font-size: 26px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}
.overview-card strong.agent {
  color: var(--agent);
}
.overview-card strong.human {
  color: var(--human);
}
.overview-card small {
  font-size: var(--text-xs);
  color: var(--muted);
}
.overview-chart {
  padding: var(--space-4) var(--space-5);
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--panel);
}
.chart-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  flex-wrap: wrap;
}
.chart-head h2 {
  margin: 0;
  font-size: 17px;
}
.chart-head p {
  margin: 4px 0 0;
  font-size: var(--text-sm);
  color: var(--muted);
}
.chart-controls {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}
.segmented {
  display: inline-flex;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: 9px;
  gap: 2px;
}
.segmented button {
  padding: 4px 10px;
  border-radius: 6px;
  font-size: var(--text-sm);
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.segmented button.active {
  background: var(--agent);
  color: white;
}
.human-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--text-sm);
}
.chart-legend {
  display: flex;
  gap: var(--space-4);
  margin: var(--space-3) 0;
  font-size: var(--text-sm);
  color: var(--muted);
}
.chart-legend span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.swatch {
  display: inline-block;
  width: 12px;
  height: 10px;
  border-radius: 3px;
}
.swatch.agent {
  background: var(--agent);
}
.swatch.human {
  width: 4px;
  background: var(--human);
}
.swatch.idle {
  border: 1px solid var(--border);
  background: repeating-linear-gradient(45deg, var(--border) 0 2px, transparent 2px 5px);
}
.chart-body {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr);
  gap: 6px;
}
.y-axis {
  position: relative;
}
.y-axis span {
  position: absolute;
  right: 0;
  transform: translateY(50%);
  font-size: var(--text-xs);
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.chart-plot {
  position: relative;
  padding-bottom: 22px;
}
.chart-plot svg {
  display: block;
  width: 100%;
  height: 220px;
  overflow: visible;
}
.grid {
  stroke: var(--border);
  stroke-dasharray: 3 4;
  vector-effect: non-scaling-stroke;
}
.idle {
  opacity: 0.7;
}
.human-mark {
  fill: var(--human);
}
.now {
  stroke: var(--status-danger, #e5484d);
  stroke-width: 2;
  vector-effect: non-scaling-stroke;
}
.x-axis {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 18px;
}
.x-axis span {
  position: absolute;
  transform: translateX(-50%);
  font-size: var(--text-xs);
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.chart-hover {
  position: absolute;
  top: 0;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 9px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg, var(--panel));
  font-size: var(--text-xs);
  pointer-events: none;
  white-space: nowrap;
  box-shadow: 0 6px 18px rgb(0 0 0 / 0.25);
}
.chart-hover span {
  color: var(--muted);
}
.chart-empty {
  position: absolute;
  inset: 0 0 22px;
  display: grid;
  place-items: center;
  margin: 0;
  color: var(--muted);
  font-size: var(--text-sm);
}
.chart-hint {
  margin: var(--space-2) 0 0;
  font-size: var(--text-xs);
  color: var(--muted);
}
@media (max-width: 900px) {
  .overview-cards {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
