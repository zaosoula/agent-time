<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { ChevronRight, Crosshair, ExternalLink, Flag, Folder, Search, X } from '@lucide/vue';
import ReportedWorkTimeline from './ReportedWorkTimeline.vue';
import SessionExplorer from './SessionExplorer.vue';
import { activityPreview, explorerSessions } from './project-explorer.ts';
import { useStore, type TimelineGroup } from './store.ts';
import { duration } from './format.ts';
import { projectColor, projectDisplay } from './project-identity.ts';
import type { ReportedWorkItem } from '../capture/reported-work.ts';
import type { Interval } from '../capture/events.ts';

/**
 * Projects of the day as compact rows that expand into a session explorer. Expanding never
 * changes the main chart; "Focus main chart" does, and clearing focus keeps rows expanded.
 */
const props = defineProps<{ focus: string }>();
const emit = defineEmits<{ 'update:focus': [name: string] }>();
const store = reactive(useStore());

const query = ref('');
const groups = computed(() => {
  const text = query.value.trim().toLowerCase();
  const all = store.timelineProjects as TimelineGroup[];
  return text ? all.filter((group) => group.name.toLowerCase().includes(text)) : all;
});
const expanded = reactive<Record<string, boolean>>({});
// A project page opens with its project expanded.
watch(
  () => [store.project, store.selectedDate],
  () => {
    for (const key of Object.keys(expanded)) delete expanded[key];
    if (store.project !== 'all') expanded[store.project] = true;
  },
  { immediate: true },
);

const reported = computed(() => store.visibleReportedWork as ReportedWorkItem[]);
const sessionsFor = (group: TimelineGroup) =>
  explorerSessions(group, store.humanBySession as ReadonlyMap<string, Interval[]>, reported.value);
const rootCount = (group: TimelineGroup) => group.sessions.filter((session) => !session.child).length;
const childCount = (group: TimelineGroup) => group.sessions.filter((session) => session.child).length;
const preview = (group: TimelineGroup) => {
  const bars = activityPreview(group.load, store.dayStart, store.dayEnd);
  const top = Math.max(1, ...bars);
  return bars.map((value) => value / top);
};

const reportedOpen = ref(false);
const reportedCounts = computed(() => {
  const counters = reported.value.filter((item) => item.kind === 'counter');
  return {
    counters: counters.length,
    checkpoints: reported.value.length - counters.length,
    seconds: counters.reduce((sum, item) => sum + ((item.active ? store.minute : item.end) - item.start), 0),
  };
});
</script>

<template>
  <section class="explorer" aria-label="Projects">
    <div class="explorer-head">
      <div>
        <h2>Project activity <span class="project-count">{{ groups.length }}</span></h2>
        <p>Explore the sessions and agents behind your day.</p>
      </div>
      <label class="search-field">
        <Search :size="14" />
        <input v-model="query" type="search" placeholder="Search projects…" aria-label="Search projects" />
      </label>
    </div>

    <div class="columns" aria-hidden="true">
      <span>Project</span><span>Across the day</span><span>Agent time</span><span>Your time</span><span>Peak</span>
    </div>

    <div
      v-for="group in groups"
      :key="group.name"
      :class="['project', { open: expanded[group.name], focused: focus === group.name }]"
    >
      <button
        class="explorer-row"
        :aria-expanded="Boolean(expanded[group.name])"
        :aria-label="`${expanded[group.name] ? 'Collapse' : 'Expand'} ${projectDisplay(group.name, store.projects)}`"
        @click="expanded[group.name] = !expanded[group.name]"
      >
        <span class="name">
          <ChevronRight :size="14" :class="{ turned: expanded[group.name] }" />
          <span class="folder" :style="{ color: projectColor(group.name) }"><Folder :size="15" /></span>
          <span class="name-text">
            <strong :title="group.name">{{ projectDisplay(group.name, store.projects) }}</strong>
            <small
              >{{ rootCount(group) }} {{ rootCount(group) === 1 ? 'session' : 'sessions'
              }}<template v-if="childCount(group)"> · {{ childCount(group) }} subagents</template
              ><template v-if="!group.sessions.length"> · your activity only</template></small
            >
          </span>
        </span>
        <span class="preview" aria-hidden="true">
          <i v-for="(value, index) in preview(group)" :key="index" :style="{ height: `${Math.max(value ? 12 : 0, value * 100)}%` }"></i>
        </span>
        <b class="agent"><small class="mobile-label">Agents</small>{{ group.agentSeconds ? duration(group.agentSeconds) : '—' }}</b>
        <b class="human"><small class="mobile-label">You</small>{{ group.humanSeconds ? duration(group.humanSeconds) : '—' }}</b>
        <b class="agent">{{ group.peakConcurrent || '—' }}</b>
      </button>

      <div v-if="expanded[group.name]" class="project-body">
        <div class="body-head">
          <span class="explorer-caption">Sessions in {{ projectDisplay(group.name, store.projects) }}</span>
          <div class="body-actions">
            <button
              v-if="focus !== group.name"
              class="btn btn-sm"
              :disabled="!group.sessions.length"
              @click="emit('update:focus', group.name)"
            >
              <Crosshair :size="13" />Focus main chart
            </button>
            <button v-else class="btn btn-sm" @click="emit('update:focus', '')"><X :size="13" />Clear focus</button>
            <button v-if="store.project !== group.name" class="btn btn-sm" @click="store.navigate('today', group.name)">
              <ExternalLink :size="13" />Open project page
            </button>
          </div>
        </div>
        <SessionExplorer :sessions="sessionsFor(group)" :now="store.minute" />
      </div>
    </div>
    <p v-if="!groups.length" class="empty">
      {{ query ? 'No project matches this search.' : 'No project activity recorded on this day.' }}
    </p>

    <div v-if="reported.length" :class="['reported', { open: reportedOpen }]">
      <button class="reported-row" :aria-expanded="reportedOpen" @click="reportedOpen = !reportedOpen">
        <Flag :size="15" />
        <span>
          <strong>Agent-reported work</strong>
          <small
            >{{ reportedCounts.counters }} timers · {{ reportedCounts.checkpoints }} checkpoints · separate from measured
            execution</small
          >
        </span>
        <b>{{ duration(reportedCounts.seconds) }}</b>
        <ChevronRight :size="14" :class="{ turned: reportedOpen }" />
      </button>
      <ReportedWorkTimeline
        v-if="reportedOpen"
        :items="reported"
        :range="{ start: store.dayStart, end: store.dayEnd }"
        :now="store.minute"
      />
    </div>
  </section>
</template>

<style scoped>
.explorer {
  display: grid;
  gap: 8px;
}
.explorer-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: var(--space-3);
  flex-wrap: wrap;
  margin-bottom: 6px;
}
.explorer-head h2 {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 19px;
  letter-spacing: -0.4px;
}
.project-count { display: inline-grid; place-items: center; min-width: 24px; height: 24px; padding: 0 6px; border-radius: 7px; font-size: var(--text-sm); font-weight: 550; background: var(--agent-soft); color: var(--agent); letter-spacing: 0; }
.explorer-head p {
  margin: 4px 0 0;
  color: var(--muted);
  font-size: var(--text-sm);
}
.columns,
.explorer-row {
  display: grid;
  grid-template-columns: minmax(200px, 1.3fr) minmax(120px, 1.6fr) 90px 70px 50px;
  align-items: center;
  gap: 14px;
}
.columns {
  padding: 0 16px;
  font-size: var(--text-xs);
  color: var(--muted);
}
.columns span:nth-child(n + 3) {
  text-align: right;
}
.project {
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--panel);
  overflow: hidden;
}
.project.open {
  border-color: color-mix(in srgb, var(--agent) 55%, var(--border));
}
.project.focused {
  box-shadow: 0 0 0 1px var(--agent);
}
.explorer-row {
  width: 100%;
  padding: 12px 16px;
  text-align: left;
}
.explorer-row:hover {
  background: color-mix(in srgb, var(--agent) 6%, transparent);
}
.name {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.turned {
  transform: rotate(90deg);
}
.folder {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: var(--bg);
}
.name-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.name-text strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.name-text small {
  color: var(--muted);
  font-size: var(--text-xs);
}
.preview {
  display: flex;
  align-items: flex-end;
  gap: 1px;
  height: 22px;
  border-bottom: 1px solid var(--border);
}
.preview i {
  flex: 1;
  background: var(--agent-chart);
  border-radius: 1px 1px 0 0;
  opacity: 0.85;
}
.explorer-row b {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
b.agent {
  color: var(--text);
}
b.agent:last-child {
  color: var(--agent);
}
b.human {
  color: var(--human);
}
.project-body {
  padding: 12px 16px 16px;
  border-top: 1px solid var(--border);
}
.body-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.explorer-caption {
  font-size: var(--text-xs);
  font-weight: 700;
  color: var(--muted);
}
.mobile-label { display: none; }
.body-actions {
  display: flex;
  gap: 8px;
}
.body-actions .btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.reported {
  margin-top: 8px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--panel);
  overflow: hidden;
}
.reported-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 12px 16px;
  text-align: left;
  color: var(--blue);
}
.reported-row span {
  display: flex;
  flex-direction: column;
  color: var(--text);
}
.reported-row small {
  color: var(--muted);
  font-size: var(--text-xs);
}
.reported-row b {
  color: var(--blue);
  font-variant-numeric: tabular-nums;
}
.empty {
  margin: 0;
  padding: 16px;
  color: var(--muted);
  font-size: var(--text-sm);
}
@media (max-width: 760px) {
  .columns {
    display: none;
  }
  .explorer-row {
    grid-template-columns: minmax(0, 1fr) auto auto;
    row-gap: 8px;
  }
  .preview {
    grid-column: 1 / -1;
    order: 5;
  }
  .explorer-row b:last-of-type {
    display: none;
  }
  .mobile-label { display: block; margin-bottom: 3px; font-size: 10px; font-weight: 400; color: var(--muted); }
  .explorer-row { padding: 12px; gap: 10px; }
  .name { gap: 6px; }
  .folder { display: none; }
  .project-body { padding: 12px; }
  .body-actions { flex-wrap: wrap; }
  .explorer-head .search-field { width: 100%; }
  .explorer-head .search-field input { width: 100%; min-width: 0; }
}
</style>
