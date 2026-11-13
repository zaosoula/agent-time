<script setup lang="ts">
import {capturePageScroll, restorePageScroll} from './page-scroll.ts';
import LoadingStatus from './LoadingStatus.vue';
import {backgroundActivities,dismissBackgroundActivity} from './background-activity.ts';
import {storagePressureDetail} from '../capture/storage-pressure-status.ts';
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { TooltipContent, TooltipPortal, TooltipProvider, TooltipRoot, TooltipTrigger } from 'reka-ui';
import {
  Activity,
  BarChart3,
  CalendarDays,
  CircleHelp,
  ClipboardCheck,
  Download,
  Folder,
  GitCommitHorizontal,
  Pause,
  Play,
  Settings2,
  X,
} from '@lucide/vue';
import type { CaptureSettings } from '../capture/settings.ts';
import { native, relaunchHookSetup, transport } from './transport.ts';
import { useStore, type Page } from './store.ts';
import { toast, clearToast } from './toast.ts';
import { dateString, duration } from './format.ts';
import { reviewDrag, reviewDragType, dropReviewActivity } from './review-workspace.ts';
import { reviewIsAssigned } from './review-apps.ts';
import { projectColor, projectDisplay } from './project-identity.ts';
import BetaUpdates from './BetaUpdates.vue';
import CaptureSettingsPage from './CaptureSettings.vue';
import ExportDialog from './ExportDialog.vue';
import HookSetup from './HookSetup.vue';
import ReviewPage from './ReviewPage.vue';
import Toasts from './Toasts.vue';
import TodayPage from './TodayPage.vue';
import ReportsPage from './ReportsPage.vue';
import ProjectsPage from './ProjectsPage.vue';
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
  { id: 'projects', title: 'Projects', icon: Folder },
  { id: 'reports', title: 'Reports', icon: BarChart3 },
];
const pageTitle = computed(() => store.page === 'settings' ? 'Settings' : pages.find((item) => item.id === store.page)?.title || 'Home');
const dayPages: Page[] = ['today', 'review'];
const projectPages: Page[] = ['today', 'projects'];
const showsProject = computed(() => projectPages.includes(store.page) || store.page === 'reports' && store.reportsSection === 'evidence');
const activityFilter = computed(() => store.page === 'today');

const reviewProjectSeconds = computed(() => {
  const totals = new Map<string,number>();
  for (const group of store.appReviewGroups) {
    const path=reviewIsAssigned(group)?group.projectPath!:'unassigned';
    totals.set(path,(totals.get(path)||0)+group.seconds);
  }
  return totals;
});
const sidebarProjects=computed(()=>store.page==='review'?[...new Set([...store.projects,...(store.websiteProjects?.projects||[]),...reviewProjectSeconds.value.keys()].filter(p=>p.startsWith('/')))].sort((a,b)=>projectDisplay(a,store.projects).localeCompare(projectDisplay(b,store.projects))):store.projects);
const reviewTotal = computed(()=>store.appReviewGroups.reduce((sum,g)=>sum+g.seconds,0));
const dropTarget=ref('');
function clearReviewDrag(){reviewDrag.value=null;dropTarget.value='';}
onMounted(()=>window.addEventListener('dragend',clearReviewDrag));
onUnmounted(()=>window.removeEventListener('dragend',clearReviewDrag));
function openSidebarProject(path:string) {
  if(store.page==='review')store.reviewProjectFilter=path;
  else if(path==='all')navigate(showsProject.value?store.page:'today','all');
  else store.openProject(path,'overview');
}
function dragOverProject(event:DragEvent,path:string) {
  if(store.page!=='review'||!reviewDrag.value||reviewDrag.value.date!==store.selectedDate||!event.dataTransfer?.types.includes(reviewDragType))return;
  event.preventDefault();event.dataTransfer.dropEffect='move';dropTarget.value=path;
}
function dropOnProject(event:DragEvent,path:string) {
  dropTarget.value='';
  if(store.page!=='review'||!event.dataTransfer)return;
  event.preventDefault();dropReviewActivity(store.selectedDate,path==='unassigned'?null:path,event.dataTransfer);
}
watch(()=>store.page,()=>{reviewDrag.value=null;dropTarget.value='';});
// ---- Navigation ---------------------------------------------------------------------------
function navigate(destination: Page, nextProject?: string) {
  store.navigate(destination, nextProject);
}
// Keep DOM scroll positions alongside the five cached workspace instances. This
// also covers deep links and tray navigation, which can change the page directly.
const pageScroll = new Map<Page, ReturnType<typeof capturePageScroll>>();
watch(() => store.page, (next, previous) => {
  const oldRoot = document.querySelector<HTMLElement>(`[data-page-context="${previous}"]`);
  if (oldRoot) pageScroll.set(previous, capturePageScroll(oldRoot));
  void nextTick().then(() => {
    if (store.page !== next) return;
    const root = document.querySelector<HTMLElement>(`[data-page-context="${next}"]`);
    if (root) restorePageScroll(root, pageScroll.get(next) || []);
  });
});
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
function openStorage(){store.openSettings('data');}
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
    else if (event.payload === 'usage') store.openUsageLimits();
    else if (['settings', 'today', 'health', 'review'].includes(event.payload))
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
        <div v-if="native" class="titlebar-space" data-tauri-drag-region></div>
        <div class="brand">
          <div class="brand-mark"><img :src="appIcon" alt="" /></div>
          <span>Agent Time</span><span class="beta-badge">BETA</span>
        </div>
        <p class="brand-caption">Your work, with agents.</p>
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
            <span
              v-else-if="item.id === 'health' && store.issues.length"
              class="issue-dot"
              aria-label="Has issues"
            ></span>
          </button>
        </nav>
        <button :class="['nav-row', 'mobile-settings', { active: store.page === 'settings' }]" :aria-current="store.page === 'settings' ? 'page' : undefined" @click="navigate('settings')"><Settings2 :size="17" /><span>Settings</span></button>
        <div class="section-label">
          Projects <span v-if="store.summaryLoaded">{{ sidebarProjects.length }}</span>
        </div>
        <button
          :class="['project-row', { selected: store.page==='review'?store.reviewProjectFilter==='all':store.project === 'all' && showsProject }]"
          @click="openSidebarProject('all')"
        >
          <Folder :size="16" /><span>{{store.page==='review'?'All activity':'All projects'}}</span><small v-if="store.page==='review'" class="project-time">{{duration(reviewTotal)}}</small>
        </button>
        <button v-if="store.page==='review'" :class="['project-row',{selected:store.reviewProjectFilter==='unassigned','review-drop-target':dropTarget==='unassigned'}]" @click="openSidebarProject('unassigned')" @dragover="dragOverProject($event,'unassigned')" @dragleave="dropTarget=''" @drop="dropOnProject($event,'unassigned')"><CircleHelp :size="16"/><span>Unassigned</span><small class="project-time">{{duration(reviewProjectSeconds.get('unassigned')||0)}}</small></button>
        <div class="project-list">
          <button
            v-for="name in sidebarProjects"
            :key="name"
            :class="['project-row', { selected: store.page==='review'?store.reviewProjectFilter===name:store.project === name && showsProject, 'review-drop-target':dropTarget===name }]"
            @click="openSidebarProject(name)" @dragover="dragOverProject($event,name)" @dragleave="dropTarget=''" @drop="dropOnProject($event,name)"
          >
            <span class="project-dot" :style="{ background: projectColor(name) }"></span>
            <span :title="name">{{ projectDisplay(name, sidebarProjects) }}</span><small v-if="store.page==='review'" class="project-time">{{duration(reviewProjectSeconds.get(name)||0)}}</small>
          </button>
          <p v-if="!store.summaryLoaded && !store.projects.length" class="sidebar-empty">Loading projects…</p>
          <p v-else-if="!store.projects.length" class="sidebar-empty">Projects appear when activity is recorded.</p>
        </div>
        <div class="sidebar-footer">
          <button :class="['nav-row',{active:store.page==='settings'}]" :aria-current="store.page==='settings'?'page':undefined" @click="navigate('settings')"><Settings2 :size="17" /><span>Settings</span></button>

        </div>
      </aside>

      <main class="main-pane">
        <header class="toolbar" data-tauri-drag-region="deep">
          <div class="breadcrumbs">
            <template v-if="showsProject && store.project !== 'all'">
              <span>{{ pageTitle }}</span>
              <span aria-hidden="true">/</span>
              <strong>{{ projectDisplay(store.project, store.projects) }}</strong>
            </template>
            <strong v-else>{{ pageTitle }}</strong>
          </div>
          <div class="toolbar-actions">
            <select v-if="activityFilter" class="toolbar-project" :value="store.project" aria-label="Filter activity by project" @change="navigate(store.page,($event.target as HTMLSelectElement).value)"><option value="all">All projects</option><option v-for="path in store.projects" :key="path" :value="path">{{ projectDisplay(path,store.projects) }}</option></select>
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
        <LoadingStatus class="page-loading" v-if="!store.summaryLoaded && ['today', 'review', 'projects'].includes(store.page)" :key="store.selectedDate" :label="store.status ? 'Preparing your activity' : 'Connecting to capture'" :detail="store.status ? 'Reading the selected day and applying your project decisions. You can open another section while this loads.' : 'Waiting for the local capture service. Your saved history stays on this Mac.'" />
        <KeepAlive :max="5">
          <TodayPage
            v-if="store.page === 'today'"
            key="today"
            mode="today"
            :data-page-context="store.page"
            :busy="busy"
            @start="toggleCapture"
          />
          <ReviewPage v-else-if="store.page === 'review'" key="review" data-page-context="review" />
          <ProjectsPage v-else-if="store.page === 'projects'" key="projects" data-page-context="projects" />
          <ReportsPage v-else-if="store.page === 'reports'" key="reports" data-page-context="reports" />
          <CaptureSettingsPage
            v-else
            key="settings"
            data-page-context="settings"
            :status="store.status"
            :busy="busy"
            @change="updateSettings"
            @error="settingsError"
            @review-site="reviewSite"
          />
        </KeepAlive>

        <footer class="statusbar">
          <button
            class="capture-status-link"
            @click="store.captureAttention ? repairCapture() : navigate('health')"
          >
            <span :class="['status-dot', { live: store.status?.running && !store.status.storageCare?.paused && !store.captureAttention }]"></span>
            {{ store.captureLabel }}
          </button>
          <span v-if="store.status?.running && !store.status.storageCare?.paused && (store.status.workingAgents || 0) > 0">{{ store.status.workingAgents }} {{ store.status.workingAgents === 1 ? 'agent working' : 'agents working' }}</span>
          <div class="background-activities" role="status" aria-live="polite">
            <template v-for="activity in backgroundActivities" :key="activity.id">
              <button class="capture-status-link" @click="activity.reveal?.(); activity.target === 'billing' ? navigate('billing') : store.openSettings('data'); if (activity.done) dismissBackgroundActivity(activity.id)">{{ activity.label }}<span v-if="activity.detail"> · {{ activity.detail }}</span></button>
              <button v-if="activity.done" class="capture-status-link" aria-label="Dismiss completed activity" @click="dismissBackgroundActivity(activity.id)"><X :size="12" /></button>
            </template>
            <button v-if="['queued','compressing'].includes(store.status?.storageCare?.pressure?.phase || '')" class="capture-status-link" @click="store.openSettings('data')">Compressing history…</button>
          </div>
        </footer>
        <ExportDialog v-model:open="exportOpen" />
      </main>
    </div>
    <Toasts />
  </TooltipProvider>
</template>

<style scoped>
.statusbar{gap:12px}.statusbar > .capture-status-link{flex-shrink:0}.background-activities{display:flex;align-items:center;gap:8px;margin-left:auto;min-width:0;overflow-x:auto}.background-activities button{white-space:nowrap}
.page-loading { --loading-inset: 32px; flex-shrink: 0; }
@media (min-width: 1500px) { .page-loading { --loading-inset: max(32px, calc((100% - 1160px) / 2)); } }
@media (max-width: 1120px) { .page-loading { --loading-inset: 24px; } }
@media (max-width: 700px) { .page-loading { --loading-inset: 18px; } }
.project-time{margin-left:auto;font-variant-numeric:tabular-nums;font-size:var(--text-xs);white-space:nowrap;color:var(--muted)}
.project-row.review-drop-target{background:var(--accent-soft);outline:2px solid var(--accent);outline-offset:-2px}
</style>
