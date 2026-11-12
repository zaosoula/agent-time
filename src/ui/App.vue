<script setup lang="ts">
import LoadingStatus from './LoadingStatus.vue';
import {storagePressureDetail} from '../capture/storage-pressure-status.ts';
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { TooltipContent, TooltipPortal, TooltipProvider, TooltipRoot, TooltipTrigger } from 'reka-ui';
import {
  Activity,
  BarChart3,
  Bot,
  CalendarDays,
  CircleHelp,
  ClipboardCheck,
  Download,
  Folder,
  GitCommitHorizontal,
  Layers3,
  Pause,
  Play,
  Settings2,
  X,
} from '@lucide/vue';
import type { CaptureSettings } from '../capture/settings.ts';
import { native, relaunchHookSetup, transport } from './transport.ts';
import { useStore, type Page } from './store.ts';
import { toast, clearToast } from './toast.ts';
import { dateString } from './format.ts';
import { projectColor, projectDisplay } from './project-identity.ts';
import BetaUpdates from './BetaUpdates.vue';
import CaptureHealthPage from './CaptureHealth.vue';
import CaptureSettingsPage from './CaptureSettings.vue';
import ExportDialog from './ExportDialog.vue';
import HookSetup from './HookSetup.vue';
import ReviewPage from './ReviewPage.vue';
import SessionInspector from './SessionInspector.vue';
import Toasts from './Toasts.vue';
import TodayPage from './TodayPage.vue';
import UsagePage from './UsagePage.vue';
import WeeklyReview from './WeeklyReview.vue';
import WorkOutcomes from './WorkOutcomes.vue';
import appIcon from './icon.svg';

const betaUpdatesEnabled = import.meta.env.VITE_BETA_UPDATES === '1';
const store = reactive(useStore());

const captureBusy = ref(false),
  settingsBusy = ref(false),
  exportOpen = ref(false);
const busy = computed(() => captureBusy.value || settingsBusy.value);

const pages: Array<{ id: Page; title: string; icon: typeof CalendarDays }> = [
  { id: 'today', title: 'Home', icon: CalendarDays },
  { id: 'review', title: 'Review', icon: ClipboardCheck },
  { id: 'sessions', title: 'Agent sessions', icon: Layers3 },
  { id: 'weekly', title: 'Weekly review', icon: BarChart3 },
  { id: 'outcomes', title: 'Work evidence', icon: GitCommitHorizontal },
  { id: 'health', title: 'Capture health', icon: Activity },
  { id: 'usage', title: 'Tokens & limits', icon: Bot },
  { id: 'settings', title: 'Settings', icon: Settings2 },
];
const pageTitle = computed(() => pages.find((item) => item.id === store.page)?.title || 'Home');
const dayPages: Page[] = ['today', 'sessions', 'review', 'outcomes'];
/** Pages that respect the sidebar's project filter. */
const projectPages: Page[] = ['today', 'sessions', 'outcomes'];
const showsProject = computed(() => projectPages.includes(store.page));

// ---- Navigation ---------------------------------------------------------------------------
function navigate(destination: Page, nextProject = 'all') {
  if (store.page === 'today') {
    const top = document.querySelector<HTMLElement>('.day-content')?.scrollTop || 0;
    sessionStorage.setItem(`agent-time.day-scroll:${store.selectedDate}`, String(top));
  }
  store.navigate(destination, nextProject);
  if (destination === 'today')
    void nextTick().then(() => {
      const pane = document.querySelector<HTMLElement>('.day-content');
      if (pane) pane.scrollTop = Number(sessionStorage.getItem(`agent-time.day-scroll:${store.selectedDate}`) || 0);
    });
}
function reviewSite(key: string) {
  store.setDate(dateString(new Date()));
  navigate('review');
  store.reviewSiteFilter = key;
}
function repairCapture() {
  if (store.captureAttention?.action === 'repair-hooks') relaunchHookSetup();
  else navigate('health');
}

// ---- Actions ------------------------------------------------------------------------------
// Action errors are sticky toasts keyed by action; they clear when that action next succeeds.
async function toggleCapture() {
  captureBusy.value = true;
  const running = store.status?.running;
  try {
    store.status = running ? await transport.stop() : await transport.start();
    clearToast('capture');
    toast.success(running ? 'Capture paused.' : 'Capture started.', 'capture-done');
  } catch (cause) {
    toast.error(cause, 'capture');
  } finally {
    captureBusy.value = false;
    void store.refreshSummary();
  }
}
async function updateSettings(settings: Partial<CaptureSettings>) {
  settingsBusy.value = true;
  try {
    store.status = await transport.settings(settings);
    clearToast('settings');
    toast.success('Settings saved.', 'settings-saved');
  } catch (cause) {
    toast.error(cause, 'settings');
  } finally {
    settingsBusy.value = false;
  }
}

function settingsError(cause: unknown) {
  toast.error(cause, 'settings');
}

// ---- Banners for problems that need attention ----------------------------------------------
const dismissedBanners = ref<Record<string, boolean>>({});
const hookBannerKey = computed(() => `hooks:${store.outdatedHooks.map((target) => target.id).join('|')}`);
const sourceBannerKey = computed(() => `sources:${store.sourceProblems.map((source) => source.id).join('|')}`);
const storagePressure = computed(()=>store.status?.storageCare?.paused?store.status.storageCare.pressure:undefined);
const storageSettingsKey = ref(0);
function openStorage(){sessionStorage.setItem('agent-time.settings-tab','data');storageSettingsKey.value++;navigate('settings');}
const pollProblem = computed(() => store.pollError || store.status?.lastError || '');
function retry() {
  void store.refreshStatus();
  void store.refreshSummary();
}

// ---- Native events ------------------------------------------------------------------------
let unlistenNavigation: (() => void) | undefined,
  unlistenDeepLink: (() => void) | undefined,
  unmounted = false;
async function listenNavigation() {
  if (!native) return;
  const { listen } = await import('@tauri-apps/api/event');
  const dispose = await listen<string>('navigate', (event) => {
    if (event.payload === 'hook-setup') {
      navigate('health');
      relaunchHookSetup();
    } else if(event.payload==='storage')openStorage();
    else if (['settings', 'today', 'usage', 'health', 'review'].includes(event.payload))
      navigate(event.payload as Page);
  });
  const disposeRestart = await listen<string | null>('collector-restarted', (event) => {
    if (event.payload) toast.error(`Collector restart failed: ${event.payload}`, 'collector-restart');
    else toast.success('Collector restarted.', 'collector-restart');
    void store.refreshStatus();
  });
  const disposeAll = () => {
    dispose();
    disposeRestart();
  };
  if (unmounted) disposeAll();
  else unlistenNavigation = disposeAll;
}
function handleDeepLink(urls: string[]) {
  for (const raw of urls) {
    try {
      const url = new URL(raw);
      if (url.protocol !== 'agenttime:' || url.pathname !== '/' || url.search || url.hash) continue;
      if (url.hostname === 'capture-health') navigate('health');
      else if (url.hostname === 'today') navigate('today');
      else if (url.hostname === 'review') navigate('review');
    } catch {
      /* Ignore malformed external URLs. */
    }
  }
}
async function listenDeepLinks() {
  if (!native) return;
  const { getCurrent, onOpenUrl } = await import('@tauri-apps/plugin-deep-link');
  const dispose = await onOpenUrl(handleDeepLink);
  if (unmounted) dispose();
  else unlistenDeepLink = dispose;
  handleDeepLink((await getCurrent()) || []);
}
function onKeydown(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key === ',') {
    event.preventDefault();
    navigate('settings');
  } else if (
    event.key === 'Escape' &&
    store.selectedSessionKey &&
    !(event.target instanceof Element && event.target.closest('[role="dialog"]'))
  ) {
    store.selectedSessionKey = '';
  }
}
watch(
  () => store.page,
  (page) => {
    if (page !== 'today' && page !== 'sessions') store.selectedSessionKey = '';
  },
);

onMounted(() => {
  store.start();
  void listenNavigation();
  void listenDeepLinks();
  window.addEventListener('keydown', onKeydown);
});
onUnmounted(() => {
  unmounted = true;
  unlistenNavigation?.();
  unlistenDeepLink?.();
  window.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <TooltipProvider :delay-duration="350">
    <HookSetup mode="onboarding" />
    <div class="app-shell">
      <aside class="sidebar">
        <div class="titlebar-space" data-tauri-drag-region></div>
        <div class="brand">
          <div class="brand-mark"><img :src="appIcon" alt="" /></div>
          <span>Agent Time</span><span class="version">Preview</span>
        </div>
        <nav class="sidebar-section" aria-label="Pages">
          <button
            v-for="item in pages"
            :key="item.id"
            :class="['nav-row', { active: store.page === item.id }]"
            :aria-current="store.page === item.id ? 'page' : undefined"
            @click="navigate(item.id)"
          >
            <component :is="item.icon" :size="17" /><span>{{ item.title }}</span>
            <span
              v-if="item.id === 'review' && store.reviewBadge"
              class="nav-count attention"
              :aria-label="`${store.reviewBadge} to review`"
            >
              {{ store.reviewBadge }}
            </span>
            <span v-else-if="item.id === 'sessions' && store.summaryLoaded" class="nav-count">
              {{ store.creditedSessions.length }}
            </span>
            <span
              v-else-if="item.id === 'health' && store.issues.length"
              class="issue-dot"
              aria-label="Has issues"
            ></span>
          </button>
        </nav>
        <div class="section-label">
          Projects <span v-if="store.summaryLoaded">{{ store.projects.length }}</span>
        </div>
        <button
          :class="['project-row', { selected: store.project === 'all' && showsProject }]"
          @click="navigate(showsProject ? store.page : 'today')"
        >
          <Folder :size="16" /><span>All projects</span>
        </button>
        <div class="project-list">
          <button
            v-for="name in store.projects"
            :key="name"
            :class="['project-row', { selected: store.project === name && showsProject }]"
            @click="navigate(showsProject ? store.page : 'today', name)"
          >
            <span class="project-dot" :style="{ background: projectColor(name) }"></span>
            <span :title="name">{{ projectDisplay(name, store.projects) }}</span>
          </button>
          <p v-if="!store.summaryLoaded && !store.projects.length" class="sidebar-empty">Loading projects…</p>
          <p v-else-if="!store.projects.length" class="sidebar-empty">Projects appear when activity is recorded.</p>
        </div>
        <div class="sidebar-footer">
          <button
            class="collector-line capture-status-link"
            @click="store.captureAttention ? repairCapture() : navigate('health')"
          >
            <span :class="['status-dot', { live: store.status?.running && !store.captureAttention }]"></span>
            <span>{{ store.captureLabel }}</span>
          </button>
          <div class="footer-line"><span>Stored on this Mac</span></div>
        </div>
      </aside>

      <main class="main-pane">
        <header class="toolbar" data-tauri-drag-region>
          <div class="breadcrumbs">
            <template v-if="showsProject && store.project !== 'all'">
              <span>{{ pageTitle }}</span>
              <span aria-hidden="true">/</span>
              <strong>{{ projectDisplay(store.project, store.projects) }}</strong>
            </template>
            <strong v-else>{{ pageTitle }}</strong>
          </div>
          <div class="toolbar-actions">
            <TooltipRoot v-if="dayPages.includes(store.page)">
              <TooltipTrigger as-child>
                <button class="icon-button" aria-label="Export this day as CSV" @click="exportOpen = true">
                  <Download :size="17" />
                </button>
              </TooltipTrigger>
              <TooltipPortal>
                <TooltipContent class="tooltip">Export this day</TooltipContent>
              </TooltipPortal>
            </TooltipRoot>
            <button class="capture-button" :disabled="busy || !store.status" @click="toggleCapture">
              <Pause v-if="store.status?.running" :size="12" /><Play v-else :size="12" />
              {{
                !store.status
                  ? 'Checking…'
                  : captureBusy
                    ? 'Updating…'
                    : store.status.running
                      ? 'Pause capture'
                      : 'Start capture'
              }}
            </button>
          </div>
        </header>

        <BetaUpdates v-if="betaUpdatesEnabled" />
        <div v-if="pollProblem" class="banner danger" role="alert">
          <CircleHelp :size="16" /><span>{{ pollProblem }}</span>
          <button class="btn btn-sm" @click="retry">Retry</button>
        </div>
        <div
          v-for="issue in store.status?.startupIssues ?? []"
          v-show="!dismissedBanners[`startup:${issue}`]"
          :key="issue"
          class="banner"
          role="alert"
        >
          <CircleHelp :size="16" /><span>{{ issue }}</span>
          <button class="icon-button" aria-label="Dismiss" @click="dismissedBanners[`startup:${issue}`] = true">
            <X :size="14" />
          </button>
        </div>
        <div v-if="storagePressure" class="banner" role="alert" aria-label="Low disk space capture pause">
          <CircleHelp :size="16" />
          <span><strong>Capture paused for low disk space.</strong> {{ storagePressureDetail(storagePressure) }}</span>
          <button class="btn btn-sm" @click="openStorage">Data &amp; backup</button>
          <button v-if="storagePressure.phase==='ready'" class="btn btn-sm" :disabled="captureBusy" @click="toggleCapture">Resume capture</button>
        </div>
        <div v-if="store.outdatedHooks.length && !dismissedBanners[hookBannerKey]" class="banner" role="alert">
          <CircleHelp :size="16" />
          <span>
            <strong>Agent tracking may have stopped.</strong> {{ store.outdatedAgents }}
            {{ store.outdatedHooks.length === 1 ? 'hook needs' : 'hooks need' }} an update, so some agent time
            may be missing.
          </span>
          <button class="btn btn-sm" @click="relaunchHookSetup">Update hooks</button>
          <button class="icon-button" aria-label="Dismiss" @click="dismissedBanners[hookBannerKey] = true">
            <X :size="14" />
          </button>
        </div>
        <div
          v-if="store.sourceProblems.length && !dismissedBanners[sourceBannerKey] && store.page !== 'health'"
          class="banner"
          role="alert"
        >
          <CircleHelp :size="16" />
          <span>
            <strong>Recording needs attention.</strong>
            {{ store.sourceProblems.map((source) => source.name).join(', ') }}
            {{ store.sourceProblems.length === 1 ? 'has' : 'have' }} not sent anything recently.
          </span>
          <button class="btn btn-sm" @click="navigate('health')">Capture health</button>
          <button class="icon-button" aria-label="Dismiss" @click="dismissedBanners[sourceBannerKey] = true">
            <X :size="14" />
          </button>
        </div>
        <LoadingStatus v-if="!store.summaryLoaded && ['today', 'sessions', 'review', 'outcomes'].includes(store.page)" :key="store.selectedDate" :label="store.status ? 'Preparing your activity' : 'Connecting to capture'" :detail="store.status ? 'Reading the selected day and applying your project decisions. You can open another section while this loads.' : 'Waiting for the local capture service. Your saved history stays on this Mac.'" />
        <TodayPage
          v-if="store.page === 'today' || store.page === 'sessions'"
          :busy="busy"
          @start="toggleCapture"
        />
        <ReviewPage v-else-if="store.page === 'review'" />
        <WeeklyReview v-else-if="store.page === 'weekly'" />
        <WorkOutcomes v-else-if="store.page === 'outcomes'" />
        <UsagePage v-else-if="store.page === 'usage'" :status="store.status" />
        <CaptureSettingsPage
          v-else-if="store.page === 'settings'"
          :key="storageSettingsKey"
          :status="store.status"
          :busy="busy"
          @change="updateSettings"
          @error="settingsError"
        />
        <CaptureHealthPage v-else :status="store.status" :issues="store.issues" @review-site="reviewSite" />

        <footer class="statusbar">
          <button
            class="capture-status-link"
            @click="store.captureAttention ? repairCapture() : navigate('health')"
          >
            <span :class="['status-dot', { live: store.status?.running && !store.captureAttention }]"></span>
            {{ store.captureLabel }}
          </button>
          <span>
            {{ native ? 'Desktop app' : 'Local browser preview' }}
            <template v-if="store.summaryLoaded"> · {{ store.summary.sessions.length }} sessions found</template>
          </span>
        </footer>
        <ExportDialog v-model:open="exportOpen" />
      </main>
      <SessionInspector v-if="store.page === 'today' || store.page === 'sessions'" />
    </div>
    <Toasts />
  </TooltipProvider>
</template>
