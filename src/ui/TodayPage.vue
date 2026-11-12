<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from 'reka-ui';
import { ArrowRight, CalendarDays, CheckCircle2, Layers3, Radio, Search, ShieldCheck, Timer } from '@lucide/vue';
import { toast } from './toast.ts';
import { minuteCreditSeconds } from '../capture/correlate.ts';
import DayOverview from './DayOverview.vue';
import DayPicker from './DayPicker.vue';
import ProjectExplorer from './ProjectExplorer.vue';
import InfoPopover from './InfoPopover.vue';
import SessionsTable from './SessionsTable.vue';
import SetupVerification from './SetupVerification.vue';
import { relaunchHookSetup } from './transport.ts';
import { useStore } from './store.ts';
import { clock, duration, longDate } from './format.ts';
import { intervalProject, projectLabel, workspaceProject, unassignedProject } from './project-identity.ts';

const props = defineProps<{ busy: boolean; mode: 'today' | 'sessions' }>();
const emit = defineEmits<{ start: [] }>();
const store = reactive(useStore());
/** Project the main chart and figures are focused on, from the explorer; empty for the whole view. */
const chartFocus = ref('');
const focusedGroup = computed(() =>
  chartFocus.value ? store.timelineProjects.find((group) => group.name === chartFocus.value) || null : null,
);
watch(
  () => [store.selectedDate, store.project],
  () => (chartFocus.value = ''),
);
const timerBusy = ref('');
/** Timers started on an earlier day and still open: almost always left behind by an agent. */
const leftoverTimers = computed(() => store.runningTimers.filter((timer) => timer.start < store.dayStart));
async function discardLeftovers() {
  const ids = leftoverTimers.value.map((timer) => timer.id);
  timerBusy.value = 'bulk';
  try {
    await store.stopTimers(ids, true);
    toast.success(`Discarded ${ids.length} leftover ${ids.length === 1 ? 'timer' : 'timers'}.`, 'timer');
  } catch (cause) {
    toast.error(cause, 'timer');
  } finally {
    timerBusy.value = '';
  }
}
async function stopTimer(id: string, discard = false) {
  timerBusy.value = id;
  try {
    await store.stopTimer(id, discard);
    toast.success(discard ? 'Timer discarded.' : 'Timer stopped.', 'timer');
  } catch (cause) {
    toast.error(cause, 'timer');
  } finally {
    timerBusy.value = '';
  }
}

const view = ref(props.mode === 'sessions' ? 'sessions' : 'timeline');

const pending = computed(() => store.reviewPending.length);
const macSource = computed(() => store.confidence.sources.find((source) => source.id === 'macos'));

// ---- Your activity details --------------------------------------------------------------
const humanIntervals = computed(() => store.filteredIntervals.filter((interval) => interval.state === 'human'));
const humanTabs = computed(() => {
  const groups = new Map<
    string,
    { workspaceId: string; tabId: string; title: string; intervals: Array<[number, number]> }
  >();
  for (const interval of humanIntervals.value) {
    if (!interval.workspaceId || !interval.tabId) continue;
    const key = `${interval.workspaceId}:${interval.tabId}`;
    const group = groups.get(key) || {
      workspaceId: interval.workspaceId,
      tabId: interval.tabId,
      title: interval.tabTitle || 'Orca tab',
      intervals: [],
    };
    group.title = interval.tabTitle || group.title;
    group.intervals.push([interval.start, interval.end]);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, seconds: minuteCreditSeconds(group.intervals) }))
    .sort((a, b) => b.seconds - a.seconds);
});
const websites = computed(() => {
  type Page = { url: string; title: string; intervals: Array<[number, number]> };
  const groups = new Map<
    string,
    { domain: string; project: string; intervals: Array<[number, number]>; browsers: Set<string>; pages: Map<string, Page> }
  >();
  for (const interval of humanIntervals.value) {
    if (!interval.browserDomain) continue;
    let domain = interval.browserDomain;
    try {
      const origin = interval.browserOrigin ? new URL(interval.browserOrigin) : undefined;
      if (origin && (['localhost', '127.0.0.1', '::1'].includes(origin.hostname) || origin.hostname.endsWith('.localhost')))
        domain = origin.host;
    } catch {
      /* Keep the captured domain. */
    }
    const project = (interval.workspaceId || interval.projectPath) ? intervalProject(interval) : unassignedProject;
    const key = `${domain}::${project}`;
    const group = groups.get(key) || { domain, project, intervals: [], browsers: new Set<string>(), pages: new Map<string, Page>() };
    group.intervals.push([interval.start, interval.end]);
    if (interval.browserBundleId)
      group.browsers.add(
        store.status?.sources.find((source) => source.bundleId === interval.browserBundleId)?.name || interval.browserBundleId,
      );
    if (interval.browserUrl) {
      const page = group.pages.get(interval.browserUrl) || { url: interval.browserUrl, title: interval.browserTitle || domain, intervals: [] };
      page.title = interval.browserTitle || page.title;
      page.intervals.push([interval.start, interval.end]);
      group.pages.set(interval.browserUrl, page);
    }
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      seconds: minuteCreditSeconds(group.intervals),
      pages: [...group.pages.values()]
        .map((page) => ({ ...page, seconds: minuteCreditSeconds(page.intervals) }))
        .sort((a, b) => b.seconds - a.seconds),
    }))
    .sort((a, b) => b.seconds - a.seconds);
});
</script>

<template>
  <section class="day-content">
    <div class="day-heading">
      <div>
        <h1>
          {{
            props.mode === 'sessions'
              ? 'Agent sessions'
              : store.project === 'all'
                ? 'Home'
                : projectLabel(store.project)
          }}
        </h1>
        <p>
          {{
            props.mode === 'sessions'
              ? longDate(store.selectedDate)
              : `${longDate(store.selectedDate)} · ${store.project === 'all' ? 'all projects' : store.project}`
          }}
          <span v-if="store.isToday && store.runningCount" class="badge good working-now">
            <Radio :size="11" />{{ store.runningCount }} {{ store.runningCount === 1 ? 'agent' : 'agents' }} working now
          </span>
          <InfoPopover v-if="store.runningTimers.length" label="Running agent timers">
            <template #trigger>
              <span class="badge working-now timers-badge"
                ><Timer :size="11" />{{ store.runningTimers.length }}
                {{ store.runningTimers.length === 1 ? 'timer' : 'timers' }} running</span
              >
            </template>
            <h3>Running agent timers</h3>
            <p>
              Timers agents started with start_task and have not stopped. A timer also ends when its agent session
              ends. Stop one to end it now, or discard one an agent left behind.
            </p>
            <p v-if="leftoverTimers.length" class="timer-bulk">
              <button class="btn btn-sm" :disabled="Boolean(timerBusy)" @click="discardLeftovers">
                Discard {{ leftoverTimers.length }} started before today
              </button>
            </p>
            <ul class="timer-list">
              <li v-for="timer in store.runningTimers" :key="timer.id">
                <span
                  ><strong :title="timer.title">{{ timer.title }}</strong
                  ><small
                    >{{ timer.provider || 'Agent' }} · since {{ clock(timer.start) }} ·
                    {{ duration(store.minute - timer.start) }}</small
                  ></span
                >
                <button class="btn btn-sm" :disabled="timerBusy === timer.id" @click="stopTimer(timer.id)">Stop</button>
                <button
                  class="btn btn-sm"
                  :disabled="timerBusy === timer.id"
                  title="Remove this timer from the timeline and counted time"
                  @click="stopTimer(timer.id, true)"
                >
                  Discard
                </button>
              </li>
            </ul>
          </InfoPopover>
        </p>
      </div>
      <DayPicker />
    </div>

    <SetupVerification
      v-if="props.mode === 'today' && store.isToday"
      :status="store.status"
      :hooks="store.hookStatus"
      :health="store.captureHealth"
      :busy="props.busy"
      @health="store.navigate('health')"
      @settings="store.navigate('settings')"
      @hooks="relaunchHookSetup"
      @start="emit('start')"
    />

    <DayOverview v-if="props.mode === 'today'" :focus="focusedGroup" @clear-focus="chartFocus = ''" />

    <div class="day-status-row">
      <button
        v-if="props.mode === 'today' && store.summaryLoaded && pending"
        class="review-cta"
        @click="store.navigate('review')"
      >
        <span class="review-cta-count">{{ pending }}</span>
        <span>{{ pending === 1 ? 'item needs' : 'items need' }} review</span>
        <ArrowRight :size="14" />
      </button>
      <span v-else-if="props.mode === 'today' && store.dayReviewed" class="badge good">
        <CheckCircle2 :size="12" />Day reviewed
      </span>
      <button
        v-else-if="props.mode === 'today' && store.summaryLoaded && store.reviewCaptured.length"
        class="btn btn-quiet btn-sm"
        @click="store.navigate('review')"
      >
        Check {{ store.reviewCaptured.length }} automatic matches
      </button>

      <span class="day-confidence-inline">
        <ShieldCheck :size="13" />
        {{
          store.confidence.attention && store.isToday
            ? `${store.confidence.attention} ${store.confidence.attention === 1 ? 'source needs' : 'sources need'} attention`
            : store.dayCaptureIssues.length
              ? `${store.dayCaptureIssues.length} capture ${store.dayCaptureIssues.length === 1 ? 'note' : 'notes'}`
              : 'Recording looks complete'
        }}
        <InfoPopover label="How complete is this day's recording?">
          <h3>Recording for this day</h3>
          <dl v-if="store.confidence.sources.length">
            <template v-for="source in store.confidence.sources" :key="source.id">
              <dt>{{ source.name }}</dt>
              <dd>{{ source.detail }}</dd>
            </template>
          </dl>
          <ul v-if="store.dayCaptureReasons.length" class="popover-list">
            <li v-for="reason in store.dayCaptureReasons" :key="reason">{{ reason }}</li>
          </ul>
          <p>Totals include only recorded activity. Past days show what was recorded at the time.</p>
          <button
            v-if="store.confidence.sources.some((source) => source.action === 'repair-hooks')"
            class="btn btn-sm"
            @click="relaunchHookSetup"
          >
            Repair hooks
          </button>
          <button class="btn btn-sm" @click="store.navigate('health')">Open capture health</button>
        </InfoPopover>
      </span>
    </div>

    <TabsRoot v-model="view" class="activity-panel">
      <div class="panel-toolbar">
        <TabsList class="segmented" aria-label="Day view">
          <TabsTrigger value="timeline"><CalendarDays :size="14" />Projects</TabsTrigger>
          <TabsTrigger value="sessions"><Layers3 :size="14" />Sessions</TabsTrigger>
        </TabsList>
        <div v-if="view === 'sessions'" class="search-field">
          <Search :size="14" />
          <input v-model="store.search" type="search" aria-label="Search sessions" placeholder="Search sessions…" />
        </div>
      </div>
      <TabsContent value="timeline"><ProjectExplorer v-model:focus="chartFocus" /></TabsContent>
      <TabsContent value="sessions"><SessionsTable /></TabsContent>
    </TabsRoot>

    <details v-if="props.mode === 'today' && (humanTabs.length || websites.length)" class="human-tabs">
      <summary class="human-tabs-summary">
        <span>
          <strong>Where your time went</strong>
          <small>{{ humanTabs.length }} Orca tabs · {{ websites.length }} websites</small>
        </span>
        <b>{{ duration(store.humanTime) }}</b>
      </summary>
      <div v-for="tab in humanTabs" :key="tab.workspaceId + tab.tabId" class="human-tab-row">
        <span>
          <strong>{{ tab.title }}</strong>
          <small>Orca · {{ projectLabel(workspaceProject(tab.workspaceId)) }}</small>
        </span>
        <b>{{ duration(tab.seconds) }}</b>
      </div>
      <details v-for="site in websites" :key="site.domain + '::' + site.project" class="human-site">
        <summary class="human-tab-row website-row">
          <span>
            <strong>{{ site.domain }}</strong>
            <small>
              {{ [...site.browsers].join(', ') || 'Browser' }} ·
              {{ site.project === unassignedProject ? 'No project' : projectLabel(site.project) }} ·
              {{ site.pages.length }} {{ site.pages.length === 1 ? 'page' : 'pages' }}
            </small>
          </span>
          <b>{{ duration(site.seconds) }}</b>
        </summary>
        <div v-for="sitePage in site.pages" :key="sitePage.url" class="human-tab-row web-page-row">
          <span>
            <strong>{{ sitePage.title }}</strong>
            <small :title="sitePage.url">{{ sitePage.url }}</small>
          </span>
          <b>{{ duration(sitePage.seconds) }}</b>
        </div>
      </details>
    </details>

    <div class="activity-note">
      <ShieldCheck :size="14" />
      <span>Recorded on this Mac only. Your time is estimated from activity; agent time comes from their events.</span>
    </div>
  </section>
</template>

<style>
.key-numbers {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-3);
  margin: var(--space-2) 0 var(--space-3);
}
.key-number {
  display: grid;
  gap: 6px;
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--panel);
}
.key-sub {
  display: block;
  margin-top: 2px;
  font-size: var(--text-xs);
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.key-label {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
  font-size: var(--text-sm);
}
.key-number strong {
  font-size: var(--text-2xl);
  font-weight: 600;
  letter-spacing: -0.4px;
  font-variant-numeric: tabular-nums;
}
.key-skeleton {
  width: 90px;
  height: 30px;
}
.day-status-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
  margin-bottom: var(--space-4);
  min-height: 30px;
}
.review-cta {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: 6px 12px 6px 6px;
  border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
  border-radius: var(--radius-pill);
  background: var(--accent-soft);
  color: var(--accent-text);
  font-size: var(--text-sm);
  font-weight: 550;
}
.review-cta:hover {
  background: color-mix(in srgb, var(--accent) 16%, transparent);
}
.review-cta-count {
  display: inline-grid;
  place-items: center;
  min-width: 22px;
  height: 22px;
  padding: 0 6px;
  border-radius: var(--radius-pill);
  background: var(--accent);
  color: var(--accent-contrast);
  font-size: var(--text-xs);
}
.day-confidence-inline {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-left: auto;
  color: var(--muted);
  font-size: var(--text-sm);
}
.working-now {
  margin-left: var(--space-2);
  vertical-align: middle;
}
.timers-badge {
  color: var(--blue);
  cursor: pointer;
}
.timer-bulk {
  margin: 0 0 8px;
}
.timer-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 260px;
  overflow: auto;
}
.timer-list li {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 0;
  border-top: 1px solid var(--border);
}
.timer-list li > span {
  flex: 1;
  min-width: 0;
}
.timer-list strong,
.timer-list small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.timer-list small {
  color: var(--muted);
  font-size: var(--text-xs);
}
.popover-list {
  margin: 0 0 8px;
  padding-left: 18px;
  color: var(--muted);
}
.popover .btn + .btn {
  margin-left: 6px;
}
.popover .overlap-track {
  margin: 4px 0 8px;
}
@media (max-width: 760px) {
  .key-numbers {
    grid-template-columns: 1fr;
  }
}
</style>
