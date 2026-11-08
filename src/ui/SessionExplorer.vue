<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { Bot, ChevronRight, Flag, Timer } from '@lucide/vue';
import type { ExplorerSession, AgentExecution } from './project-explorer.ts';
import { clock, duration } from './format.ts';

/** Sessions of one project on the left, the selected session and its agent executions on the right. */
const props = defineProps<{ sessions: ExplorerSession[]; now: number }>();
const selectedKey = ref('');
const executionKey = ref('');
const selected = computed(() => props.sessions.find((item) => item.key === selectedKey.value) || props.sessions[0]);
const execution = computed<AgentExecution | undefined>(() =>
  selected.value?.executions.find((item) => item.key === executionKey.value),
);
watch(
  () => selected.value?.key,
  () => (executionKey.value = ''),
);

const windowLabel = (start: number | null, end: number | null) =>
  start === null || end === null ? 'No activity on this day' : `${clock(start)}–${clock(end)}`;
const sessionLabel = (index: number) => `S${String(index + 1).padStart(2, '0')}`;

// Arrow keys move through sessions, like a list box.
const list = ref<HTMLElement | null>(null);
async function moveSelection(event: KeyboardEvent) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !props.sessions.length) return;
  event.preventDefault();
  const index = props.sessions.findIndex((item) => item.key === selected.value?.key);
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? props.sessions.length - 1
        : Math.min(props.sessions.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)));
  selectedKey.value = props.sessions[next]!.key;
  await nextTick();
  list.value?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
}

// Session-scale concurrency chart.
const width = 600,
  height = 90;
const chart = computed(() => {
  const session = selected.value;
  if (!session || session.start === null || session.end === null || !session.load.length) return null;
  const span = Math.max(60, session.end - session.start),
    scale = Math.max(1, session.peak);
  const x = (time: number) => ((time - session.start!) / span) * width;
  const y = (count: number) => height - (count / scale) * (height - 10);
  let path = '',
    cursor: number | undefined;
  for (const step of session.load) {
    const from = x(step.start),
      to = x(step.end),
      total = step.roots + step.children;
    if (cursor === undefined || from > cursor + 0.01)
      path += `${cursor === undefined ? '' : `L${cursor},${height} `}M${from},${height} `;
    path += `L${from},${y(total)} L${to},${y(total)} `;
    cursor = to;
  }
  return { path: `${path}L${cursor},${height} Z`, start: session.start, end: session.end };
});
const executionLabel = (item: AgentExecution) =>
  item.child ? item.session.title : `${item.session.title} · main agent`;
/** Short agent ID, so subagents of the same type can be told apart. */
const shortId = (item: AgentExecution) => (item.child && item.session.agentId ? item.session.agentId.slice(0, 7) : '');
const contextLimit = 6;
const showAllContext = ref(false);
watch(
  () => selected.value?.key,
  () => (showAllContext.value = false),
);
const contextItems = computed(() => {
  const items = [...(selected.value?.reported || [])].sort((a, b) => b.start - a.start);
  return showAllContext.value ? items : items.slice(0, contextLimit);
});
</script>

<template>
  <div class="session-explorer">
    <div class="session-list" role="listbox" aria-label="Sessions" ref="list" @keydown="moveSelection">
      <div class="panel-title">
        <strong>Sessions</strong><small>{{ sessions.length }} recorded</small>
      </div>
      <button
        v-for="(item, index) in sessions"
        :key="item.key"
        role="option"
        :aria-selected="item.key === selected?.key"
        :tabindex="item.key === selected?.key ? 0 : -1"
        :class="['session-item', { selected: item.key === selected?.key }]"
        @click="selectedKey = item.key"
      >
        <span class="session-tag">{{ sessionLabel(index) }}</span>
        <span class="session-text">
          <strong :title="item.title">{{ item.title }}</strong>
          <small>{{ windowLabel(item.start, item.end) }}</small>
        </span>
        <span class="session-figures">
          <strong>{{ duration(item.agentSeconds) }}</strong>
          <small>{{ item.executions.length }} {{ item.executions.length === 1 ? 'agent' : 'agents' }}</small>
        </span>
      </button>
      <p v-if="!sessions.length" class="empty">No agent sessions in this project on this day.</p>
    </div>

    <div v-if="selected" class="session-inspector" aria-live="polite">
      <span class="eyebrow">Session {{ sessionLabel(sessions.indexOf(selected)) }}</span>
      <h3 :title="selected.title">{{ selected.title }}</h3>
      <p class="muted">
        {{ selected.session.provider || 'Agent' }} · Execution window {{ windowLabel(selected.start, selected.end) }}
      </p>
      <div class="chips">
        <span class="chip"><b>{{ duration(selected.agentSeconds) }}</b> agent time</span>
        <span class="chip"><b>{{ duration(selected.wallSeconds) }}</b> elapsed</span>
        <span class="chip"><b>{{ selected.subagents }}</b> subagents</span>
        <span class="chip"><b>{{ selected.peak }}</b> peak</span>
        <span v-if="selected.humanSeconds !== null" class="chip human"><b>{{ duration(selected.humanSeconds) }}</b> you</span>
      </div>

      <div class="section-head">
        <strong>Concurrent agents</strong><small>This session and its subagents</small>
      </div>
      <div class="session-chart">
        <svg v-if="chart" :viewBox="`0 0 ${width} ${height}`" preserveAspectRatio="none" role="img" :aria-label="`Peak ${selected.peak} agents at once`">
          <path :d="chart.path" class="area" />
        </svg>
        <p v-else class="empty">No measured activity to chart.</p>
        <div v-if="chart" class="session-axis">
          <span>{{ clock(chart.start) }}</span><span>Peak {{ selected.peak }}</span><span>{{ clock(chart.end) }}</span>
        </div>
      </div>

      <div class="section-head">
        <strong>Agent executions</strong><small>{{ selected.executions.length }} recorded</small>
      </div>
      <ul class="executions">
        <li v-for="item in selected.executions" :key="item.key">
          <button
            :class="['execution', { selected: execution?.key === item.key }]"
            :aria-expanded="execution?.key === item.key"
            @click="executionKey = executionKey === item.key ? '' : item.key"
          >
            <span class="execution-icon"><Bot :size="14" /></span>
            <span class="execution-text">
              <strong :title="executionLabel(item)">{{ executionLabel(item) }}</strong>
              <small
                >{{ [item.child ? 'Subagent' : 'Main agent', shortId(item), windowLabel(item.start, item.end)]
                  .filter(Boolean)
                  .join(' · ') }}</small
              >
            </span>
            <b>{{ duration(item.seconds) }}</b>
            <ChevronRight :size="14" :class="{ open: execution?.key === item.key }" />
          </button>
          <dl v-if="execution?.key === item.key" class="execution-detail">
            <dt>Agent</dt>
            <dd>{{ item.session.provider || 'Unknown' }}{{ item.session.agentId ? ` · ${item.session.agentId}` : '' }}</dd>
            <dt>Measured time</dt>
            <dd>{{ duration(item.seconds) }} · tool time {{ duration(item.session.observedSeconds) }}</dd>
            <dt>Window</dt>
            <dd>{{ windowLabel(item.start, item.end) }}</dd>
            <dt>State</dt>
            <dd>{{ item.session.state }} · evidence {{ item.session.proof }}</dd>
            <template v-if="item.session.runId || item.session.taskId">
              <dt>Orchestration</dt>
              <dd>{{ item.session.runId || 'No run' }} · {{ item.session.taskId || 'No task' }}</dd>
            </template>
            <dt>Provider session</dt>
            <dd class="mono">{{ item.session.sessionId || 'Not linked' }}</dd>
          </dl>
        </li>
      </ul>

      <div v-if="selected.reported.length" class="task-context">
        <strong>Task context</strong>
        <small>Reported by the agent · not measured time · latest first</small>
        <p v-for="item in contextItems" :key="item.id">
          <Timer v-if="item.kind === 'counter'" :size="12" /><Flag v-else :size="12" />
          {{ item.title }}
          <span class="muted"
            >· {{ clock(item.start) }}{{ item.kind === 'counter' ? `–${item.active ? 'now' : clock(item.end)}` : '' }}</span
          >
        </p>
        <button
          v-if="selected.reported.length > contextLimit"
          class="link-button"
          @click="showAllContext = !showAllContext"
        >
          {{ showAllContext ? 'Show fewer' : `Show all ${selected.reported.length}` }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.session-explorer {
  display: grid;
  grid-template-columns: minmax(240px, 0.9fr) minmax(0, 1.6fr);
  gap: var(--space-4);
}
.session-list,
.session-inspector {
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg);
  min-width: 0;
}
.session-list {
  display: flex;
  flex-direction: column;
  padding-bottom: 6px;
  max-height: 640px;
  overflow: auto;
}
.panel-title {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
}
.panel-title small,
.muted,
small {
  color: var(--muted);
}
.session-item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 10px;
  align-items: center;
  margin: 4px 6px 0;
  padding: 9px 10px;
  border: 1px solid transparent;
  border-radius: 9px;
  text-align: left;
}
.session-item:hover {
  background: var(--panel);
}
.session-item.selected {
  border-color: var(--agent);
  background: color-mix(in srgb, var(--agent) 16%, transparent);
}
.session-tag {
  padding: 3px 6px;
  border-radius: 6px;
  background: var(--panel);
  font-size: var(--text-xs);
  font-weight: 700;
}
.session-item.selected .session-tag {
  background: var(--agent);
  color: white;
}
.session-text,
.session-figures {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.session-text strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-sm);
}
.session-figures {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.session-text small,
.session-figures small {
  font-size: var(--text-xs);
}
.session-inspector {
  padding: 14px 16px;
}
.eyebrow {
  font-size: var(--text-xs);
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted);
}
.session-inspector h3 {
  margin: 4px 0 2px;
  font-size: 18px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.session-inspector > p {
  margin: 0;
  font-size: var(--text-sm);
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 12px 0 4px;
}
.chip {
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: 7px;
  font-size: var(--text-xs);
  color: var(--muted);
}
.chip b {
  color: var(--agent);
}
.chip.human b {
  color: var(--human);
}
.section-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin: 16px 0 8px;
  font-size: var(--text-sm);
}
.section-head small {
  font-size: var(--text-xs);
}
.session-chart {
  padding: 10px 12px 6px;
  border: 1px solid var(--border);
  border-radius: 10px;
}
.session-chart svg {
  display: block;
  width: 100%;
  height: 90px;
}
.area {
  fill: color-mix(in srgb, var(--agent) 70%, transparent);
}
.session-axis {
  display: flex;
  justify-content: space-between;
  margin-top: 4px;
  font-size: var(--text-xs);
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.executions {
  max-height: 420px;
  overflow: auto;
  padding-right: 2px !important;
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 6px;
}
.execution {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 10px;
  border: 1px solid var(--border);
  border-radius: 9px;
  text-align: left;
}
.execution.selected {
  border-color: var(--agent);
  background: color-mix(in srgb, var(--agent) 12%, transparent);
}
.execution-icon {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  background: var(--agent-soft);
  color: var(--agent);
}
.execution-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.execution-text strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--text-sm);
}
.execution-text small {
  font-size: var(--text-xs);
}
.execution b {
  font-variant-numeric: tabular-nums;
  font-size: var(--text-sm);
}
.execution svg.open {
  transform: rotate(90deg);
}
.execution-detail {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 4px 12px;
  margin: 6px 0 4px 36px;
  font-size: var(--text-xs);
}
.execution-detail dt {
  color: var(--muted);
}
.execution-detail dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.task-context {
  margin-top: 12px;
  padding: 10px 12px;
  border-left: 3px solid var(--blue);
  border-radius: 8px;
  background: var(--panel);
  font-size: var(--text-sm);
}
.task-context small {
  display: block;
  font-size: var(--text-xs);
  margin-bottom: 4px;
}
.task-context p {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 4px 0 0;
}
.link-button {
  margin-top: 6px;
  color: var(--blue);
  font-size: var(--text-xs);
}
.task-context p {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.empty {
  padding: 16px;
  margin: 0;
  color: var(--muted);
  font-size: var(--text-sm);
}
@media (max-width: 760px) {
  .session-explorer {
    grid-template-columns: 1fr;
  }
  .session-list {
    max-height: 320px;
  }
}
</style>
