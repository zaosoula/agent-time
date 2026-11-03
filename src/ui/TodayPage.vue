<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from 'reka-ui';
import { ArrowRight, Bot, CalendarDays, CheckCircle2, Clock3, Layers3, Monitor, Radio, Search, ShieldCheck } from '@lucide/vue';
import { minuteCreditSeconds } from '../capture/correlate.ts';
import DayPicker from './DayPicker.vue';
import DayTimeline from './DayTimeline.vue';
import InfoPopover from './InfoPopover.vue';
import SessionsTable from './SessionsTable.vue';
import SetupVerification from './SetupVerification.vue';
import { relaunchHookSetup } from './transport.ts';
import { useStore } from './store.ts';
import { clock, duration, longDate } from './format.ts';
import { projectLabel, workspaceProject, unassignedProject } from './project-identity.ts';

const props = defineProps<{ busy: boolean }>();
const emit = defineEmits<{ start: [] }>();
const store = reactive(useStore());

const view = ref(store.page === 'sessions' ? 'sessions' : 'timeline');
watch(
  () => store.page,
  (page) => {
    if (page === 'sessions') view.value = 'sessions';
    else if (page === 'today') view.value = 'timeline';
  },
);

const pending = computed(() => store.reviewPending.length);
const macSource = computed(() => store.confidence.sources.find((source) => source.id === 'macos'));
const daySpan = computed(() => store.dayEnd - store.dayStart);

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
    const project = interval.workspaceId ? workspaceProject(interval.workspaceId) : unassignedProject;
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
        <h1>{{ store.page === 'sessions' ? 'Agent sessions' : longDate(store.selectedDate) }}</h1>
        <p>
          {{ store.page === 'sessions' ? longDate(store.selectedDate) : 'Your work and the agents working alongside you.' }}
          <span v-if="store.isToday && store.runningCount" class="badge good working-now">
            <Radio :size="11" />{{ store.runningCount }} {{ store.runningCount === 1 ? 'agent' : 'agents' }} working now
          </span>
        </p>
      </div>
      <DayPicker />
    </div>

    <SetupVerification
      v-if="store.page === 'today' && store.isToday"
      :status="store.status"
      :hooks="store.hookStatus"
      :health="store.captureHealth"
      :busy="props.busy"
      @health="store.navigate('health')"
      @settings="store.navigate('settings')"
      @hooks="relaunchHookSetup"
      @start="emit('start')"
    />

    <div class="key-numbers" aria-label="Totals for this day">
      <div class="key-number">
        <span class="key-label">
          <Monitor :size="14" />My time
          <InfoPopover label="About my time">
            <h3>My time</h3>
            <p>
              Time you were actively using your Mac{{ store.project === 'all' ? '' : ' on this project' }}, estimated
              from the app in front and keyboard or mouse input. Each stretch counts at least one minute.
            </p>
            <dl>
              <dt>Mac activity source</dt>
              <dd>{{ macSource?.detail || 'Not observed yet' }}</dd>
            </dl>
          </InfoPopover>
        </span>
        <strong v-if="store.summaryLoaded">{{ duration(store.humanTime) }}</strong>
        <span v-else class="skeleton key-skeleton"></span>
      </div>
      <div class="key-number">
        <span class="key-label">
          <Bot :size="14" />Agent time
          <InfoPopover label="About agent time">
            <h3>Agent time</h3>
            <p>
              Time agents spent working, added up across sessions. When several agents run at once, this can be
              more than the time that passed.
            </p>
            <dl>
              <dt>Agents with recorded work</dt>
              <dd>{{ store.observedAgentSources }}</dd>
              <dt>Time with several agents at once</dt>
              <dd>{{ duration(store.agentOverlap.seconds) }}</dd>
              <dt>Most agents at once</dt>
              <dd>{{ store.agentOverlap.peak }}</dd>
              <dt>Orchestration runs</dt>
              <dd>{{ store.runs }}</dd>
            </dl>
            <div
              v-if="store.agentOverlap.steps.length"
              class="overlap-track"
              role="img"
              :aria-label="`Agent activity across this day; ${duration(store.agentOverlap.seconds)} had several agents at once`"
            >
              <span
                v-for="step in store.agentOverlap.steps"
                :key="`${step.start}:${step.end}`"
                :class="{ multiple: step.roots > 1 }"
                :style="{
                  left: `${Math.max(0, ((step.start - store.dayStart) / daySpan) * 100)}%`,
                  width: `${Math.max(0, ((Math.min(step.end, store.dayEnd) - Math.max(step.start, store.dayStart)) / daySpan) * 100)}%`,
                }"
                :title="`${clock(step.start)}–${clock(step.end)} · ${step.roots} agents`"
              ></span>
            </div>
            <p>Darker bars show several agents working together.</p>
          </InfoPopover>
        </span>
        <strong v-if="store.summaryLoaded">{{ duration(store.agentTime) }}</strong>
        <span v-else class="skeleton key-skeleton"></span>
      </div>
      <div class="key-number">
        <span class="key-label">
          <Clock3 :size="14" />Elapsed
          <InfoPopover label="About elapsed time">
            <h3>Elapsed</h3>
            <p>
              Clock time with any activity, yours or an agent's. Time when several things happened at once is
              counted only once.
            </p>
          </InfoPopover>
        </span>
        <strong v-if="store.summaryLoaded">{{ duration(store.elapsedTime) }}</strong>
        <span v-else class="skeleton key-skeleton"></span>
      </div>
    </div>

    <div class="day-status-row">
      <button
        v-if="store.page === 'today' && store.summaryLoaded && pending"
        class="review-cta"
        @click="store.navigate('review')"
      >
        <span class="review-cta-count">{{ pending }}</span>
        <span>{{ pending === 1 ? 'item needs' : 'items need' }} review</span>
        <ArrowRight :size="14" />
      </button>
      <span v-else-if="store.page === 'today' && store.dayReviewed" class="badge good">
        <CheckCircle2 :size="12" />Day reviewed
      </span>
      <button
        v-else-if="store.page === 'today' && store.summaryLoaded && store.reviewCaptured.length"
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
          <TabsTrigger value="timeline"><CalendarDays :size="14" />Timeline</TabsTrigger>
          <TabsTrigger value="sessions"><Layers3 :size="14" />Sessions</TabsTrigger>
        </TabsList>
        <div class="search-field">
          <Search :size="14" />
          <input v-model="store.search" type="search" aria-label="Search sessions" placeholder="Search sessions…" />
        </div>
      </div>
      <TabsContent value="timeline"><DayTimeline @start="emit('start')" /></TabsContent>
      <TabsContent value="sessions"><SessionsTable /></TabsContent>
    </TabsRoot>

    <details v-if="store.page === 'today' && (humanTabs.length || websites.length)" class="human-tabs">
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
  color: #fff;
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
