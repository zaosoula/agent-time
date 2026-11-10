<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted, nextTick, reactive } from 'vue';
import { Check, ChevronRight, RotateCcw, AppWindow } from '@lucide/vue';
import { humanReviewState, type HumanReviewGroup } from '../capture/human-review.ts';
import { minuteCreditSeconds } from '../capture/correlate.ts';
import {
  transport,
  reviewTransport,
  splitTransport,
  rulePreviewTransport,
  type WebsiteRuleImpact,
  type ReviewAction,
} from './transport.ts';
import { useStore } from './store.ts';
import { clock, dateTime, duration } from './format.ts';
import { humanizeError } from './errors.ts';
import { windowVisible } from './polling.ts';
import ProjectPicker from './ProjectPicker.vue';
import ReviewTimeline from './ReviewTimeline.vue';
import {buildAppReviewGroups,reviewAppSections,reviewGroupId,reviewSelection,reviewShortcutAllowed,type AppReviewGroup,type ReviewAppSection} from './review-apps.ts';

const emit = defineEmits<{
  note: [start: number, end: number, label: string];
}>();
const store = reactive(useStore());
const root = ref<HTMLElement | null>(null);

const choices = ref<Record<string, string>>({}),
  error = ref(''),
  notice = ref(''),
  pending = ref(''),
  viewMode = ref<'queue' | 'reviewed' | 'all'>('all'),
  filterText = ref(''),
  openApps = ref<Record<string,boolean>>({}),
  appLimits = ref<Record<string,number>>({}),
  selectedGroups = ref<Record<string, boolean>>({}),
  bulkProject = ref(''),
  focused = ref(''),
  rulePreview = ref(''),
  rulePatterns = ref<Record<string, string>>({}),
  openRows = ref<Record<string, boolean>>({});
const history = ref<ReviewAction[]>([]);
const splitDraft = ref<{
  key: string;
  start: number;
  end: number;
  at: number;
  before: string;
  after: string;
} | null>(null);
const ruleImpact = ref<WebsiteRuleImpact | null>(null);

const intervals = computed(() => store.dayIntervals);
const dayEventIds = computed(() => new Set(intervals.value.flatMap((interval) => interval.sourceEventIds)));
const dayHistory = computed(() =>
  history.value.filter((action) => action.eventIds.some((eventId) => dayEventIds.value.has(eventId))),
);
const undoAvailable = computed(() => dayHistory.value.some((action) => action.canUndo));

const id = reviewGroupId;
const name = (path: string) => path.split('/').filter(Boolean).at(-1) || path;
const historyLabel = (action: ReviewAction) =>
  action.mode === 'assigned'
    ? `assigned to ${name(action.projectPath || '')}`
    : action.mode === 'unassigned'
      ? 'left unassigned'
      : action.mode === 'split'
        ? 'split between projects'
        : 'reset to the automatic match';

const projectPaths = computed(() =>
  [
    ...new Set([
      ...(store.websiteProjects?.projects || []),
      ...intervals.value.flatMap((interval) =>
        interval.workspaceId ? [interval.workspaceId.split('::').at(-1)!] : [],
      ),
    ]),
  ]
    .filter((path) => path.startsWith('/'))
    .sort((a, b) => name(a).localeCompare(name(b))),
);

// Derive app visits from the same day intervals used by the shared timing totals.
const groups = computed(() =>
  buildAppReviewGroups(intervals.value).filter(
    (group) =>
      !store.reviewSiteFilter ||
      Boolean(
        group.browserUrl?.startsWith(store.reviewSiteFilter) || group.browserOrigin === store.reviewSiteFilter,
      ),
  ),
);
const priority = { conflict: 0, unmatched: 1, captured: 2, reviewed: 3 };
const queue = computed(() =>
  groups.value
    .filter(
      (group) =>
        humanReviewState(group) !== 'reviewed' &&
        !(store.dayReviewed && humanReviewState(group) === 'captured'),
    )
    .sort(
      (a, b) =>
        priority[humanReviewState(a)] - priority[humanReviewState(b)] ||
        b.seconds - a.seconds ||
        b.start - a.start,
    ),
);
const reviewed = computed(() =>
  groups.value
    .filter(
      (group) =>
        Boolean(group.userAttribution) || (store.dayReviewed && humanReviewState(group) === 'captured'),
    )
    .sort((a, b) => b.start - a.start),
);
const matchesFilter = (group: HumanReviewGroup, query: string) =>
  [(group as AppReviewGroup).appName, group.label, group.detail, group.projectPath, group.attributionSource, group.attributionReason].some(
    (value) => value?.toLocaleLowerCase().includes(query),
  );
const activeGroups = computed(() => {
  const rows =
    viewMode.value === 'all' ? groups.value : viewMode.value === 'reviewed' ? reviewed.value : queue.value;
  const query = filterText.value.trim().toLocaleLowerCase();
  return query ? rows.filter((group) => matchesFilter(group, query)) : rows;
});
const apps = computed(() => reviewAppSections(activeGroups.value));
const observedSeconds = computed(() => activeGroups.value.reduce((n,group) => n+group.seconds,0));
const isAppOpen = (app:ReviewAppSection) => openApps.value[app.key] ?? apps.value[0]?.key===app.key;
const children = (app:ReviewAppSection) => app.groups.slice(0,appLimits.value[app.key]||30);
const visible = computed(() => apps.value.flatMap(app=>isAppOpen(app)?children(app):[]));
const selection = computed(() => reviewSelection(activeGroups.value,selectedGroups.value));
const bulkGroups = computed(() => selection.value.groups);
const selectedSeconds = computed(() => selection.value.seconds);
const appMeta = computed(() => new Map(apps.value.map(app=>{
  const eligible=app.groups.filter(group=>!group.reviewSegment),count=eligible.filter(group=>selectedGroups.value[id(group)]).length;
  const identities=new Set(app.groups.map(group=>JSON.stringify([group.userAttribution||humanReviewState(group),group.projectPath||''])));
  const conflict=app.groups.some(group=>humanReviewState(group)==='conflict');
  return [app.key,{eligible,checked:eligible.length>0&&count===eligible.length,partial:count>0&&count<eligible.length,label:conflict?'Conflicting matches':identities.size===1?stateLabel(app.groups[0]!):'Mixed projects',conflict}] as const;
})));
function toggleApp(app:ReviewAppSection){openApps.value[app.key]=!isAppOpen(app);}
function toggleAllApps(){const all=apps.value.every(isAppOpen);openApps.value=Object.fromEntries(apps.value.map(app=>[app.key,!all]));}
function selectApp(app:ReviewAppSection,checked:boolean){
  if(pending.value)return;
  for(const group of appMeta.value.get(app.key)!.eligible)selectedGroups.value[id(group)]=checked;
}
function selectVisible(){if(!pending.value)selectedGroups.value=Object.fromEntries(visible.value.filter(group=>!group.reviewSegment).map(group=>[id(group),true]));}
async function selectTimeline(groupId:string){
  if(pending.value)return;
  const group=activeGroups.value.find(group=>id(group)===groupId);if(!group)return;
  if(!group.reviewSegment)selectedGroups.value[groupId]=!selectedGroups.value[groupId];
  else openRows.value[groupId]=true;
  await focusGroup(group);
}
watch([viewMode,filterText,()=>store.reviewSiteFilter],()=>{selectedGroups.value={};bulkProject.value='';focused.value='';},{flush:'sync'});
watch(activeGroups,groups=>{
  const valid=new Set(groups.filter(group=>!group.reviewSegment).map(id));
  if(Object.keys(selectedGroups.value).some(key=>!valid.has(key)))selectedGroups.value=Object.fromEntries(Object.entries(selectedGroups.value).filter(([key,value])=>value&&valid.has(key)));
});
const humanSecondsFor = (accept: (interval: (typeof intervals.value)[number]) => boolean) =>
  minuteCreditSeconds(
    intervals.value
      .filter((interval) => interval.state === 'human' && accept(interval))
      .map((interval) => [interval.start, interval.end]),
  );
const bulkProjectBefore = computed(() =>
  humanSecondsFor((interval) => interval.workspaceId?.split('::').at(-1) === bulkProject.value),
);
const bulkProjectAfter = computed(() => {
  const pairs = new Set(bulkGroups.value.flatMap((group) => group.pairs.map((pair) => pair.join(':'))));
  return humanSecondsFor(
    (interval) =>
      interval.workspaceId?.split('::').at(-1) === bulkProject.value ||
      pairs.has(interval.sourceEventIds.join(':')),
  );
});

/** One suggestion per visible row, resolved once instead of four lookups per render. */
const suggestions = computed(() => {
  const matches = store.websiteProjects?.matches || [];
  const result = new Map<string, NonNullable<(typeof matches)[number]['suggestions'][number]>>();
  if (!matches.length) return result;
  for (const group of visible.value) {
    const match = matches.find(
      (item) => group.browserUrl?.startsWith(item.key) || group.browserOrigin === item.key,
    )?.suggestions[0];
    if (match) result.set(id(group), match);
  }
  return result;
});
const suggestion = (group: HumanReviewGroup) => suggestions.value.get(id(group));

// ---- Per-day state ------------------------------------------------------------------------
const reviewStateKey = computed(() => `agent-time.review:${store.selectedDate}`);
watch(
  reviewStateKey,
  (key) => {
    // A different day starts with a clean slate: no stale notices, choices or selections.
    error.value = '';
    notice.value = '';
    choices.value = {};
    selectedGroups.value = {};
    splitDraft.value = null;
    openRows.value = {};
    rulePreview.value = '';
    ruleImpact.value = null;
    appLimits.value = {};
    openApps.value = {};
    bulkProject.value = '';
    try {
      const saved = JSON.parse(sessionStorage.getItem(key) || '{}');
      viewMode.value = ['queue', 'reviewed', 'all'].includes(saved.viewMode) ? saved.viewMode : 'all';
      filterText.value = typeof saved.filterText === 'string' ? saved.filterText : '';
      focused.value = typeof saved.focused === 'string' ? saved.focused : '';
    } catch {
      /* Ignore old review state. */
    }
  },
  { immediate: true },
);
watch([viewMode, filterText, focused], () =>
  sessionStorage.setItem(
    reviewStateKey.value,
    JSON.stringify({ viewMode: viewMode.value, filterText: filterText.value, focused: focused.value }),
  ),
);
watch(
  () => store.reviewSiteFilter,
  (filter) => {
    if (filter) {
      viewMode.value = 'queue';
      appLimits.value = {};
      openApps.value = {};
      bulkProject.value = '';
    }
  },
  { immediate: true },
);

async function loadHistory() {
  try {
    history.value = await reviewTransport.history();
  } catch (cause) {
    error.value = humanizeError(cause);
  }
}
async function loadProjects() {
  try {
    await store.refreshWebsiteProjects();
  } catch (cause) {
    error.value = humanizeError(cause);
  }
}
// Rules can change in Settings or another window: reload when the window comes back.
watch(windowVisible, (shown) => {
  if (shown) void loadProjects();
});

/** Run a review action and apply the day summary it returns. */
async function act(key: string, run: (date: string) => Promise<Parameters<typeof store.applyReviewedSummary>[0]>) {
  if(pending.value)return false;
  const date = store.selectedDate;
  pending.value = key;
  error.value = '';
  try {
    store.applyReviewedSummary(await run(date), date);
    if(date!==store.selectedDate)return false;
    await loadHistory();
    return date===store.selectedDate;
  } catch (cause) {
    if(date===store.selectedDate)error.value = humanizeError(cause);
    return false;
  } finally {
    pending.value = '';
  }
}

async function undo(action: ReviewAction) {
  if (!action.canUndo || pending.value) return;
  if (await act('undo', (date) => reviewTransport.undo(action.id, date))) notice.value = 'Decision undone.';
}

// ---- Keyboard shortcuts -------------------------------------------------------------------
function ignoreShortcut(event: KeyboardEvent) {
  const target = event.target;
  if (!(target instanceof Element)) return false;
  return !reviewShortcutAllowed(event.key, {
    editing: Boolean(target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="dialog"], [role="listbox"], [role="combobox"], [role="menu"]')),
    picker: Boolean(target.closest('[aria-haspopup]:not([aria-haspopup="false"])')),
    nativeControl: Boolean(target.closest('button, a[href], summary, [role="button"]')),
    inReview: Boolean(root.value?.contains(target) || target === document.body),
  });
}
function keyboard(event: KeyboardEvent) {
  if (event.defaultPrevented || ignoreShortcut(event)) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && !event.shiftKey) {
    const action = dayHistory.value.find((item) => item.canUndo);
    if (action) {
      event.preventDefault();
      void undo(action);
    }
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if(pending.value)return;
  const rows=apps.value.flatMap(app=>app.groups),current=rows.findIndex(group=>id(group)===focused.value),group=rows[current];
  if(event.key==='j'||event.key==='k'){
    event.preventDefault();const index=Math.max(0,Math.min(rows.length-1,current+(event.key==='j'?1:-1)));if(rows[index])void focusGroup(rows[index]!);return;
  }
  if(['1','2','3'].includes(event.key)&&bulkGroups.value.length){
    const path=projectPaths.value[Number(event.key)-1];if(path){event.preventDefault();bulkProject.value=path;}return;
  }
  if(event.key===' '&&group&&!group.reviewSegment){event.preventDefault();selectedGroups.value[id(group)]=!selectedGroups.value[id(group)];return;}
  const assign=event.key.toLowerCase()==='a'||event.key==='Enter'&&!(event.target as Element)?.closest('button');
  if(assign){
    if(bulkGroups.value.length){event.preventDefault();void bulkAssign();}
    else if(group&&!group.reviewSegment){event.preventDefault();void decide(group,'assigned');}
  }
  if(event.key.toLowerCase()==='u'){
    if(bulkGroups.value.length){event.preventDefault();void bulkDecide('unassigned');}
    else if(group&&!group.reviewSegment){event.preventDefault();void decide(group,'unassigned');}
  }
}
async function focusGroup(group:HumanReviewGroup){
  focused.value=id(group);
  const app=apps.value.find(app=>app.groups.some(item=>id(item)===id(group)));
  if(app){openApps.value[app.key]=true;const index=app.groups.findIndex(item=>id(item)===id(group));appLimits.value[app.key]=Math.max(appLimits.value[app.key]||30,Math.ceil((index+1)/30)*30);}
  await nextTick();document.getElementById(`review-${id(group)}`)?.focus();
}

onMounted(() => {
  window.addEventListener('keydown', keyboard);
  void loadHistory();
  void loadProjects();
});
onUnmounted(() => window.removeEventListener('keydown', keyboard));

// ---- Decisions ----------------------------------------------------------------------------
async function bulkAssign(){return bulkDecide('assigned');}
async function bulkDecide(mode:'assigned'|'unassigned'){
  if(pending.value)return;
  if(mode==='assigned'&&!bulkProject.value){error.value='Choose a project folder first.';return;}
  const {pairs,overLimit}=selection.value;if(!pairs.length)return;
  if(overLimit){error.value=`This selection covers ${pairs.length} recorded intervals; assign at most 10,000 at a time. Select fewer items.`;return;}
  const seconds=selectedSeconds.value,count=bulkGroups.value.length,project=bulkProject.value;
  if(await act('bulk',date=>transport.setHumanDecision(pairs,mode,mode==='assigned'?project:undefined,date))){
    notice.value=`${duration(seconds)} across ${count} ${count===1?'visit':'visits'} ${mode==='assigned'?`assigned to ${name(project)}`:'left unassigned'}. The original recording is kept.`;
    selectedGroups.value={};
  }
}
function selected(group: HumanReviewGroup) {
  return choices.value[id(group)] || group.projectPath || '';
}
function futurePatterns(group: HumanReviewGroup): string[] {
  if (!group.browserUrl && !group.browserOrigin) return [];
  try {
    const url = new URL(group.browserUrl || group.browserOrigin!);
    if (!['http:', 'https:'].includes(url.protocol)) return [];
    if (['github.com', 'www.github.com'].includes(url.hostname)) {
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length >= 2) return [`${url.origin}/${parts[0]}/${parts[1]}`];
    }
    const path = url.pathname.replace(/\/$/, '');
    return [...new Set([...(path && path !== '/' ? [url.origin + path] : []), url.origin])];
  } catch {
    return [];
  }
}
function futurePattern(group: HumanReviewGroup) {
  return rulePatterns.value[id(group)] || futurePatterns(group)[0] || '';
}
function choosePattern(group: HumanReviewGroup, value: string) {
  rulePatterns.value[id(group)] = value;
  rulePreview.value = '';
  ruleImpact.value = null;
}
function previewReady(group: HumanReviewGroup) {
  return (
    rulePreview.value === id(group) &&
    ruleImpact.value?.projectPath === selected(group) &&
    ruleImpact.value.pattern === futurePattern(group)
  );
}
async function decide(group: HumanReviewGroup, mode: 'assigned' | 'unassigned' | 'clear', saveFuture = false) {
  const key = id(group),
    path = mode === 'assigned' ? selected(group) : undefined,
    seconds = group.seconds,
    pattern = futurePattern(group);
  if (mode === 'assigned' && !path) {
    error.value = 'Choose a project folder first.';
    return;
  }
  if (saveFuture && !previewReady(group)) {
    error.value = 'Preview this future rule before saving it.';
    return;
  }
  const done = await act(key, (date) => transport.setHumanDecision(group.pairs, mode, path, date));
  if (!done) return;
  notice.value = `${duration(seconds)} ${mode === 'assigned' ? `assigned to ${name(path!)}` : mode === 'unassigned' ? 'left unassigned' : 'returned to the automatic match'}. The original recording is kept.`;
  focused.value = key;
  if (saveFuture) {
    try {
      store.websiteProjects = await transport.setWebsiteRule(pattern, path!);
      notice.value += ` Future visits to ${pattern} will use this project.`;
      rulePreview.value = '';
      ruleImpact.value = null;
    } catch (cause) {
      error.value = `The activity was assigned, but the future rule was not saved: ${humanizeError(cause)}`;
    }
  }
}
async function saveRule(group: HumanReviewGroup) {
  const path = selected(group),
    pattern = futurePattern(group);
  if (!path || !pattern) {
    error.value = 'Choose a project and a website first.';
    return;
  }
  if (!previewReady(group)) {
    error.value = 'Preview this future rule before saving it.';
    return;
  }
  pending.value = id(group);
  error.value = '';
  try {
    store.websiteProjects = await transport.setWebsiteRule(pattern, path);
    rulePreview.value = '';
    ruleImpact.value = null;
    notice.value = `Future visits to ${pattern} will go to ${name(path)}. Past activity is unchanged.`;
  } catch (cause) {
    error.value = humanizeError(cause);
  } finally {
    pending.value = '';
  }
}
async function previewRule(group: HumanReviewGroup) {
  const pattern = futurePattern(group),
    path = selected(group);
  if (!pattern || !path) return;
  try {
    ruleImpact.value = await rulePreviewTransport.preview(pattern, path);
    rulePreview.value = id(group);
  } catch (cause) {
    error.value = humanizeError(cause);
  }
}
async function assignSuggestion(group: HumanReviewGroup) {
  const match = suggestion(group);
  if (!match) return;
  choices.value[id(group)] = match.projectPath;
  await decide(group, 'assigned');
}
function openSplit(group: HumanReviewGroup) {
  const keys = new Set(group.pairs.map((pair) => pair.join(':'))),
    parts = intervals.value.filter(
      (interval) => interval.state === 'human' && keys.has(interval.sourceEventIds.join(':')),
    );
  const start = Math.min(...parts.map((part) => part.start)),
    end = Math.max(...parts.map((part) => part.end));
  const before = parts.find((part) => part.reviewSegment === 'before'),
    after = parts.find((part) => part.reviewSegment === 'after');
  const side = (segment: 'before' | 'after') => {
    const paths = [
      ...new Set(
        parts
          .filter((part) => part.reviewSegment === segment)
          .map((part) => part.workspaceId?.split('::').at(-1) || ''),
      ),
    ];
    return paths.length === 1 ? paths[0]! : '';
  };
  openRows.value[id(group)] = true;
  splitDraft.value = {
    key: id(group),
    start,
    end,
    at: before?.end || Math.floor((start + end) / 2),
    before: before ? side('before') : group.projectPath || '',
    after: after ? side('after') : '',
  };
}
function isOpen(group: HumanReviewGroup) {
  return Boolean(openRows.value[id(group)]) || splitDraft.value?.key === id(group);
}
function toggleOpen(group: HumanReviewGroup) {
  openRows.value[id(group)] = !isOpen(group);
  if (!openRows.value[id(group)] && splitDraft.value?.key === id(group)) splitDraft.value = null;
}
function title(group: HumanReviewGroup) {
  const parts = group.label.split(' · ');
  return parts.filter((part, index) => parts.indexOf(part) === index).join(' · ');
}
function shortDetail(group: HumanReviewGroup) {
  const detail = group.detail || '';
  if(detail===(group as AppReviewGroup).bundleId)return '';
  try {
    const url = new URL(detail);
    if (['http:', 'https:'].includes(url.protocol)) {
      const path = url.pathname.replace(/\/$/, '');
      return url.hostname.replace(/^www\./, '') + path;
    }
  } catch {
    /* Not a URL. */
  }
  return detail === group.label || detail === title(group) ? '' : detail;
}
function rowState(group: HumanReviewGroup) {
  return group.userAttribution ? 'decided' : humanReviewState(group);
}
function stateLabel(group: HumanReviewGroup) {
  if (group.userAttribution === 'assigned') return name(group.projectPath || '');
  if (group.userAttribution === 'unassigned') return 'Unassigned';
  const state = humanReviewState(group);
  if (state === 'conflict') return 'Conflicting matches';
  if (group.projectPath) return `Matched · ${name(group.projectPath)}`;
  return 'No project';
}
async function saveSplit(group: HumanReviewGroup) {
  const draft = splitDraft.value;
  if (!draft || draft.key !== id(group)) return;
  const done = await act(id(group), (date) =>
    splitTransport.save(group.pairs, draft.at, draft.before || undefined, draft.after || undefined, date),
  );
  if (!done) return;
  splitDraft.value = null;
  notice.value = `Split ${group.label} at ${clock(draft.at)}. Both parts stay linked to the original recording.`;
}
</script>

<template>
  <section ref="root" class="human-review" aria-labelledby="human-review-title">
    <div class="human-review-body">
      <ReviewTimeline :date="store.selectedDate" :intervals="intervals" :groups="activeGroups" :selected="selectedGroups" :focused="focused" @select="selectTimeline" />
      <div class="app-review-heading"><h2 id="human-review-title">App activity <small>{{ duration(observedSeconds) }} observed</small></h2><span>{{ apps.length }} apps · {{ activeGroups.length }} visits</span></div>
      <div class="human-review-controls" role="group" aria-label="Activity view">
        <button :class="{active:viewMode==='queue'}" :aria-pressed="viewMode==='queue'" @click="viewMode='queue'">To review · {{ queue.length }}</button>
        <button :class="{active:viewMode==='reviewed'}" :aria-pressed="viewMode==='reviewed'" @click="viewMode='reviewed'">Decided · {{ reviewed.length }}</button>
        <button :class="{active:viewMode==='all'}" :aria-pressed="viewMode==='all'" @click="viewMode='all'">All activity</button>
        <span v-if="store.reviewSiteFilter" class="badge info">{{ store.reviewSiteFilter }}<button class="btn btn-quiet btn-sm" @click="store.reviewSiteFilter=''">Clear filter</button></span>
        <input v-model="filterText" class="human-review-filter" type="search" aria-label="Filter activity by app, website, project, or evidence" placeholder="Filter by app, website or project" />
      </div>
      <div class="app-review-tools"><button class="btn btn-quiet btn-sm" :disabled="!apps.length" @click="toggleAllApps">{{ apps.every(isAppOpen)?'Collapse all':'Expand all' }}</button><button class="btn btn-quiet btn-sm" :disabled="Boolean(pending)||!visible.length" @click="selectVisible">Select visible visits</button></div>
      <p v-if="error" class="human-review-error" role="alert">{{ error }} <button class="btn btn-quiet btn-sm" @click="error=''">Dismiss</button></p>
      <p v-if="notice" class="human-review-notice" role="status">{{ notice }}<button v-if="undoAvailable" class="btn btn-sm" :disabled="Boolean(pending)" @click="undo(dayHistory.find(action=>action.canUndo)!)">Undo ⌘Z</button><button class="btn btn-quiet btn-sm" @click="notice=''">Dismiss</button></p>
      <div v-if="!store.summaryLoaded" class="human-review-empty" aria-hidden="true"><span v-for="index in 3" :key="index" class="skeleton" style="height:38px;margin:6px 0" /></div>
      <div v-else-if="!apps.length" class="human-review-empty">{{ filterText?'No activity matches this filter.':store.reviewSiteFilter?'No recorded activity for this site on this day.':viewMode==='all'?'No activity recorded on this day.':viewMode==='reviewed'?'Nothing decided yet on this day.':'Nothing left to review on this day.' }}</div>
      <div v-else class="app-review-list">
        <div class="app-review-columns"><span>Time</span><span>App / activity</span><span>Project</span><span /></div>
        <section v-for="app in apps" :key="app.key" class="review-app" :aria-label="`${app.label} activity`">
          <header class="review-app-header">
            <button type="button" class="review-app-toggle" :aria-expanded="isAppOpen(app)" @click="toggleApp(app)"><strong class="app-review-duration">{{ duration(app.seconds) }}</strong><ChevronRight :size="14" :class="{expanded:isAppOpen(app)}" /><AppWindow :size="17" /><span>{{ app.label }} <small>{{ app.groups.length }} visits<span v-if="app.hostId && app.hostId!=='local'"> · {{ app.hostId }}</span></small></span></button>
            <span class="review-app-project" :class="{conflict:appMeta.get(app.key)!.conflict}" :title="appMeta.get(app.key)!.label">{{ appMeta.get(app.key)!.label }}</span>
            <label class="review-app-check"><input type="checkbox" :checked="appMeta.get(app.key)!.checked" :indeterminate="appMeta.get(app.key)!.partial" :disabled="Boolean(pending)||!appMeta.get(app.key)!.eligible.length" :aria-label="`Select all eligible ${app.label} visits`" @change="selectApp(app,($event.target as HTMLInputElement).checked)" /></label>
          </header>
          <template v-if="isAppOpen(app)">
            <article v-for="group in children(app)" :id="`review-${id(group)}`" :key="id(group)" class="review-row" :class="[rowState(group),{focused:focused===id(group),open:isOpen(group),picked:selectedGroups[id(group)]}]" tabindex="0" data-review-visit @focus="focused=id(group)">
              <div class="review-main">
                <strong class="app-review-duration">{{ duration(group.seconds) }}</strong>
                <button class="review-what" type="button" :aria-expanded="isOpen(group)" :title="group.detail" @click="toggleOpen(group)"><ChevronRight :size="12" class="review-chevron" :class="{expanded:isOpen(group)}" /><span><strong>{{ group.label===app.label?'Foreground activity':title(group) }}</strong><small>{{ clock(group.start) }}–{{ clock(group.end) }}<template v-if="shortDetail(group)"> · {{ shortDetail(group) }}</template><template v-if="group.reviewSegment"> · Part {{ group.reviewSegment }} the split</template></small></span></button>
                <span class="review-state" :title="group.attributionReason||group.projectPath||undefined"><Check v-if="group.userAttribution==='assigned'" :size="11" />{{ stateLabel(group) }}</span>
                <label v-if="!group.reviewSegment" class="review-app-check"><input v-model="selectedGroups[id(group)]" type="checkbox" :disabled="Boolean(pending)" :aria-label="`Select ${group.label} at ${clock(group.start)} for bulk assignment`" /></label><span v-else class="review-app-check" aria-label="Split activity; edit through Change split" />
              </div>
        <div
          v-for="item in store.notes.filter((note) => note.start >= group.start && note.end <= group.end)"
          :key="item.id"
          class="human-review-note"
        >
          <strong>Note</strong><span>{{ item.note }}</span>
        </div>
        <div v-if="isOpen(group)" class="review-detail">
<div v-if="!group.reviewSegment" class="review-single-actions">
  <ProjectPicker :model-value="selected(group)" :paths="projectPaths" :label="`Project for ${group.label}`" @update:model-value="choices[id(group)]=$event;rulePreview=''" />
  <button class="btn btn-sm" :disabled="Boolean(pending)||!selected(group)" @click="decide(group,'assigned')">{{ group.userAttribution?'Reassign':'Assign' }} {{ duration(group.seconds) }}</button>
  <button class="btn btn-sm" :disabled="Boolean(pending)" @click="decide(group,'unassigned')">Leave unassigned</button>
  <button v-if="group.userAttribution" class="btn btn-quiet btn-sm" :disabled="Boolean(pending)" @click="decide(group,'clear')"><RotateCcw :size="12" /> Reset to automatic match</button>
</div>
        <div v-if="suggestion(group) && !group.userAttribution" class="review-suggestion">
          <span>
            Suggested <strong>{{ name(suggestion(group)!.projectPath) }}</strong> ·
            {{ suggestion(group)!.source.replaceAll('_', ' ') }} · {{ suggestion(group)!.detail }}
          </span>
          <button :disabled="Boolean(pending)" @click="assignSuggestion(group)">
            Assign {{ duration(group.seconds) }}
          </button>
        </div>

          <dl>
            <dt>Source</dt>
            <dd>{{ group.detail || group.label }}</dd>
            <dt>Why this match</dt>
            <dd :class="{ 'human-review-conflict': group.attributionSource === 'conflict' }">
              {{ group.attributionReason || 'Nothing linked this activity to a project.' }}
            </dd>
            <dt>Recordings</dt>
            <dd>{{ group.pairs.length }} · kept unchanged when you assign or undo</dd>
          </dl>
          <div class="human-review-actions">
            <template v-if="!group.reviewSegment">
              <button
                v-if="group.end - group.start >= 2"
                class="btn btn-sm"
                :disabled="Boolean(pending)"
                @click="openSplit(group)"
              >
                Split between projects…
              </button>
            </template>
            <template v-else>
              <button class="btn btn-sm" :disabled="Boolean(pending)" @click="openSplit(group)">Change split…</button>
              <button class="btn btn-sm" :disabled="Boolean(pending)" @click="decide(group, 'clear')">
                Remove split
              </button>
            </template>
            <button class="btn btn-sm" @click="emit('note', group.start, group.end, group.label)">Add note</button>
          </div>
          <div v-if="splitDraft?.key === id(group)" class="human-review-split">
            <strong>Divide {{ group.label }}</strong>
            <label>
              Split at {{ clock(splitDraft.at) }}
              <input
                v-model.number="splitDraft.at"
                type="range"
                :min="Math.ceil(splitDraft.start + 1)"
                :max="Math.floor(splitDraft.end - 1)"
                step="1"
                :aria-label="`Split time for ${group.label}`"
              />
            </label>
            <div>
              <span>Before</span>
              <ProjectPicker v-model="splitDraft.before" :paths="projectPaths" label="Project before split" />
              <button @click="splitDraft.before = ''">Leave unassigned</button>
            </div>
            <div>
              <span>After</span>
              <ProjectPicker v-model="splitDraft.after" :paths="projectPaths" label="Project after split" />
              <button @click="splitDraft.after = ''">Leave unassigned</button>
            </div>
            <p>
              The original recording stays unchanged. The two parts need different projects, or one can stay
              unassigned.
            </p>
            <button
              class="btn btn-primary btn-sm"
              :disabled="Boolean(pending) || splitDraft.before === splitDraft.after"
              @click="saveSplit(group)"
            >
              Save split
            </button>
            <button class="btn btn-sm" @click="splitDraft = null">Cancel</button>
          </div>
          <div v-if="futurePatterns(group).length" class="human-review-future">
            <label>
              Future visits
              <select
                :value="futurePattern(group)"
                @change="choosePattern(group, ($event.target as HTMLSelectElement).value)"
              >
                <option v-for="pattern in futurePatterns(group)" :key="pattern" :value="pattern">
                  {{ pattern }}
                </option>
              </select>
            </label>
            <button class="btn btn-sm" :disabled="Boolean(pending) || !selected(group)" @click="previewRule(group)">
              Preview future rule
            </button>
            <div v-if="rulePreview === id(group)" class="human-review-rule-preview">
              <strong>Future visits only</strong>
              <span>{{ futurePattern(group) }} and pages beneath it → {{ name(selected(group)) }}</span>
              <span v-if="ruleImpact">
                {{ ruleImpact.affectedIntervals }} of {{ ruleImpact.observedIntervals }} website visits from the
                last 7 days would have gone to a different project.
              </span>
              <span
                v-for="example in ruleImpact?.examples.slice(0, 3) || []"
                :key="`${example.url}:${example.currentProject}`"
              >
                {{ example.url }} · {{ example.currentProject ? name(example.currentProject) : 'Unassigned' }} →
                {{ name(selected(group)) }}
              </span>
              <small>
                For shared sites, choose a narrow page prefix. A whole site covers every page. Past activity is
                assigned separately.
              </small>
              <button
                v-if="!group.userAttribution"
                class="btn btn-primary btn-sm"
                :disabled="Boolean(pending) || !previewReady(group)"
                @click="decide(group, 'assigned', true)"
              >
                Assign activity and save future rule
              </button>
              <button
                v-else
                class="btn btn-primary btn-sm"
                :disabled="Boolean(pending) || !previewReady(group)"
                @click="saveRule(group)"
              >
                Save future rule
              </button>
            </div>
          </div>
        </div>

            </article>
            <button v-if="app.groups.length>children(app).length" class="btn btn-quiet btn-sm app-review-more" @click="appLimits[app.key]=(appLimits[app.key]||30)+30">Show more {{ app.label }} visits ({{ app.groups.length-children(app).length }} remaining)</button>
          </template>
        </section>
      </div>
      <div v-if="bulkGroups.length" class="app-review-assignment" aria-label="Assign selected activity">
        <div class="app-review-selection" aria-live="polite"><strong>{{ bulkGroups.length }} {{ bulkGroups.length===1?'visit':'visits' }} · {{ duration(selectedSeconds) }}</strong><small>{{ selection.pairs.length }} {{ selection.pairs.length===1?'recording':'recordings' }} selected</small></div>
        <ProjectPicker v-model="bulkProject" :paths="projectPaths" label="Project for selected activity" />
        <span v-if="bulkProject" class="bulk-impact">{{ name(bulkProject) }}: {{ duration(bulkProjectBefore) }} → {{ duration(bulkProjectAfter) }}</span>
        <button class="btn btn-primary btn-sm" :disabled="Boolean(pending)||!bulkProject" @click="bulkAssign">{{ selection.hasDecisions?'Reassign':'Assign' }} {{ duration(selectedSeconds) }}</button>
        <button class="btn btn-sm" :disabled="Boolean(pending)" @click="bulkDecide('unassigned')">Leave unassigned</button>
        <button class="btn btn-quiet btn-sm" :disabled="Boolean(pending)" @click="selectedGroups={}">Clear</button>
        <div v-if="projectPaths.length" class="app-review-project-shortcuts"><button v-for="(path,index) in projectPaths.slice(0,3)" :key="path" class="btn btn-quiet btn-sm" :disabled="Boolean(pending)" :aria-pressed="bulkProject===path" @click="bulkProject=path">{{ index+1 }} {{ name(path) }}</button></div>
      </div>
      <details v-if="dayHistory.length" class="human-review-history">
        <summary>Decision history · {{ dayHistory.length }} recent changes</summary>
        <ol>
          <li v-for="action in dayHistory" :key="action.id">
            {{ dateTime(action.at) }} · {{ action.count }}
            {{ action.count === 1 ? 'recording' : 'recordings' }} {{ historyLabel(action)
            }}{{ action.undoneAt ? ' · undone' : '' }}
            <button v-if="action.canUndo" class="btn btn-sm" :disabled="Boolean(pending)" @click="undo(action)">
              Undo
            </button>
          </li>
        </ol>
        <small>An earlier decision can be undone when its activity has not been changed since.</small>
      </details>

      <p class="human-review-shortcuts">J / K navigate · Space select · 1–3 project · Enter / A assign · U leave unassigned · ⌘Z undo</p>
    </div>
  </section>
</template>

<style scoped>
.human-review {
  margin: 16px 0;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
  overflow: hidden;
}
.human-review-body {
  padding: 15px 17px;
}
.human-review-body > p {
  font-size: 11px;
  color: var(--muted);
  margin: 0 0 12px;
}
.human-review-controls {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.human-review-controls > button,
.human-review-controls span button {
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  font-size: var(--text-xs);
  padding: 5px 8px;
  cursor: pointer;
}
.human-review-controls > button.active {
  color: var(--text);
  background: var(--hover);
}
.human-review-controls span {
  font-size: var(--text-xs);
  color: var(--muted);
  margin-left: auto;
}
.human-review-error {
  color: var(--status-danger) !important;
}
.human-review-empty {
  font-size: 11px;
  color: var(--muted);
  padding: 17px 0;
}
.human-review-row {
  padding: 12px 0;
  border-top: 1px solid var(--border);
}
.human-review-row-head {
  display: flex;
  justify-content: space-between;
  align-items: start;
  gap: 12px;
  font-size: 11px;
}
.human-review-row-head > div {
  min-width: 0;
}
.human-review-row-head strong {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.human-review-row-head small {
  display: block;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-top: 3px;
}
.human-review-row-head > span {
  white-space: nowrap;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.human-review-evidence {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin: 8px 0;
  color: var(--muted);
  font-size: var(--text-xs);
}
.human-review-user {
  color: var(--status-good);
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.human-review-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.human-review-actions input {
  flex: 1 1 230px;
  min-width: 0;
  border: 1px solid var(--border);
  background: var(--hover);
  border-radius: 6px;
  padding: 7px 9px;
  color: var(--text);
  font-size: 11px;
}
.human-review-actions button,
.human-review-future button,
.human-review-more {
  border: 1px solid var(--border);
  background: var(--hover);
  color: var(--text);
  border-radius: 6px;
  padding: 7px 9px;
  font-size: var(--text-xs);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.human-review-actions button:disabled,
.human-review-future button:disabled {
  opacity: 0.5;
  cursor: default;
}
.human-review-future {
  display: flex;
  align-items: center;
  gap: 9px;
  flex-wrap: wrap;
  margin-top: 7px;
}
.human-review-future button {
  background: transparent;
}
.human-review-future small {
  font-size: var(--text-xs);
  color: var(--muted);
}
.human-review-more {
  margin-top: 12px;
}
.human-review-evidence button {
  border: 1px solid var(--border);
  border-radius: 5px;
  background: transparent;
  color: var(--muted);
  padding: 2px 6px;
  font-size: var(--text-xs);
  cursor: pointer;
}
.human-review-bulk {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin: 0 0 12px;
}
.human-review-bulk button {
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--hover);
  padding: 6px 8px;
  color: var(--text);
  font-size: var(--text-xs);
}
.human-review-bulk button:disabled {
  opacity: 0.5;
}
.human-review-bulk span,
.human-review-select {
  font-size: var(--text-xs);
  color: var(--muted);
}
.human-review-bulk input {
  flex: 1 1 190px;
  min-width: 0;
  border: 1px solid var(--border);
  background: var(--hover);
  border-radius: 6px;
  padding: 6px 8px;
  color: var(--text);
  font-size: var(--text-xs);
}
.human-review-select {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-bottom: 7px;
}
.human-review-conflict {
  color: var(--status-warning);
}
.human-review-filter {
  flex: 1 1 200px;
  margin-left: auto;
  box-sizing: border-box;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--hover);
  color: var(--text);
  font-size: 11px;
}
.human-review-proof {
  font-size: var(--text-xs);
  color: var(--muted);
  margin: 0 0 9px;
}
.human-review-proof summary {
  cursor: pointer;
  color: var(--blue);
}
.human-review-proof dl {
  display: grid;
  grid-template-columns: 105px minmax(0, 1fr);
  gap: 5px 9px;
  margin: 8px 0;
}
.human-review-proof dt {
  color: var(--muted);
}
.human-review-proof dd {
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--text);
}
.human-review-row {
  padding: 16px 0;
}
.human-review-row:focus-visible,
.human-review-row.focused {
  outline: 2px solid var(--blue);
  outline-offset: -2px;
  border-radius: 6px;
}
.human-review-row-head,
.human-review-actions button,
.human-review-bulk button {
  font-size: 12px;
}
.human-review-row-head small,
.human-review-evidence,
.human-review-proof,
.human-review-controls > button,
.human-review-controls span button {
  font-size: 11px;
}
.human-review-actions button,
.human-review-bulk button {
  min-height: 34px;
}
.human-review-notice {
  display: flex;
  align-items: center;
  gap: 12px;
  color: var(--status-good) !important;
}
.human-review-notice button {
  color: var(--blue);
}
.human-review-shortcuts {
  font-size: var(--text-xs) !important;
}
.human-review-rule-preview {
  display: flex;
  flex-direction: column;
  gap: 5px;
  width: 100%;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 11px;
}
.human-review-rule-preview button {
  align-self: flex-start;
  color: var(--blue);
}
.human-review {
  overflow: visible;
}
.human-review-bulk .bulk-impact {
  margin-left: 0;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}
.human-review-evidence button {
  max-width: 100%;
  text-align: left;
  color: var(--blue);
  overflow-wrap: anywhere;
}
.human-review-evidence button small {
  display: block;
  margin-top: 3px;
  color: var(--muted);
  font-size: var(--text-xs);
}
.human-review-future label {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: var(--text-xs);
  color: var(--muted);
}
.human-review-future select {
  max-width: min(400px, 70vw);
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--panel);
  color: var(--text);
  font: inherit;
}
.human-review-note {
  display: flex;
  align-items: start;
  gap: 8px;
  margin-top: 8px;
  padding: 8px;
  border-left: 2px solid var(--blue);
  background: var(--hover);
  font-size: 11px;
  overflow-wrap: anywhere;
}
.human-review-note strong {
  color: var(--blue);
}
.human-review-history {
  margin: 8px 0 14px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 7px;
  font-size: 11px;
}
.human-review-history summary {
  cursor: pointer;
}
.human-review-history ol {
  margin: 9px 0;
  padding-left: 19px;
  color: var(--muted);
}
.human-review-history li {
  padding: 3px 0;
}
.human-review-history button {
  color: var(--blue);
}
.human-review-split {
  display: grid;
  gap: 9px;
  margin: 10px 0;
  padding: 13px;
  border: 1px solid var(--blue);
  border-radius: 8px;
  font-size: 11px;
}
.human-review-split > div {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.human-review-split > div > span {
  width: 46px;
}
.human-review-split label {
  display: grid;
  gap: 4px;
}
.human-review-split input[type='range'] {
  width: 100%;
}
.human-review-split p {
  margin: 0;
  color: var(--muted);
}
.human-review-split button {
  padding: 6px 9px;
  border-radius: 6px;
  background: var(--hover);
  color: var(--text);
}
.human-review-split button:disabled {
  opacity: 0.5;
}
.review-row {
  position: relative;
  border-top: 1px solid var(--border);
  padding: 8px 8px 8px 12px;
  font-size: 12px;
}
.review-row::before {
  content: '';
  position: absolute;
  left: 0;
  top: 8px;
  bottom: 8px;
  width: 3px;
  border-radius: 2px;
  background: var(--border);
}
.review-row.unmatched::before {
  background: var(--blue);
}
.review-row.conflict::before {
  background: var(--status-warning);
}
.review-row.decided::before {
  background: var(--status-good);
}
.review-row:hover {
  background: var(--hover);
}
.review-row:focus-visible,
.review-row.focused {
  outline: 2px solid var(--blue);
  outline-offset: -2px;
  border-radius: 6px;
}
.review-main {
  display: grid;
  grid-template-columns: 16px 92px minmax(0, 1fr) auto minmax(150px, 220px) auto auto;
  align-items: center;
  gap: 10px;
}
.review-check {
  width: 14px;
  height: 14px;
  margin: 0;
}
.review-time {
  display: flex;
  flex-direction: column;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.3;
}
.review-time strong {
  color: var(--text);
  font-size: 12px;
}
.review-what {
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text);
  text-align: left;
  cursor: pointer;
}
.review-what strong,
.review-what small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.review-what small {
  color: var(--muted);
  font-size: 11px;
  margin-top: 2px;
}
.review-state {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 3px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--muted);
  font-size: 11px;
}
.review-row.unmatched .review-state {
  color: var(--blue);
  border-color: color-mix(in srgb, var(--blue) 45%, transparent);
}
.review-row.conflict .review-state {
  color: var(--status-warning);
  border-color: color-mix(in srgb, var(--status-warning) 40%, transparent);
}
.review-row.decided .review-state {
  color: var(--status-good);
  border-color: color-mix(in srgb, var(--status-good) 40%, transparent);
}
.review-picker {
  min-width: 0;
}
.review-picker :deep(.project-picker-current) {
  min-height: 30px;
  padding: 5px 8px;
}
.review-picker :deep(.project-picker-current small) {
  display: none;
}
.review-main > button {
  min-height: 30px;
  padding: 5px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--hover);
  color: var(--text);
  font-size: 12px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
}
.review-main > button:disabled {
  opacity: 0.45;
  cursor: default;
}
.review-main > button.review-primary:not(:disabled) {
  background: var(--blue);
  border-color: var(--blue);
  color: #fff;
}
.review-main > button.review-what {
  min-height: 0;
  padding: 0;
  border: 0;
  background: transparent;
  justify-content: flex-start;
  display: flex;
  align-items: center;
  gap: 4px;
}
.review-what > span {
  min-width: 0;
}
.review-chevron {
  flex: none;
  color: var(--muted);
  transition: transform 0.15s;
}
.review-chevron.expanded {
  transform: rotate(90deg);
}
.review-segment {
  grid-column: span 3;
  color: var(--muted);
  font-size: 11px;
}
.review-suggestion {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 6px 0 0 118px;
  font-size: 11px;
  color: var(--muted);
}
.review-suggestion strong {
  color: var(--text);
}
.review-suggestion button {
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: transparent;
  color: var(--blue);
  font-size: 11px;
  cursor: pointer;
}
.review-row .human-review-note {
  margin-left: 118px;
}
.review-detail {
  display: grid;
  gap: 10px;
  margin: 10px 0 4px 118px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--panel);
}
.review-detail dl {
  display: grid;
  grid-template-columns: 90px minmax(0, 1fr);
  gap: 4px 10px;
  margin: 0;
  font-size: 11px;
}
.review-detail dt {
  color: var(--muted);
}
.review-detail dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.review-detail .human-review-future {
  margin-top: 0;
}
@media (max-width: 820px) {
  .review-main {
    grid-template-columns: 16px 80px minmax(0, 1fr) auto;
  }
  .review-state {
    grid-column: 3/5;
    justify-self: start;
  }
  .review-picker {
    grid-column: 2/4;
  }
  .review-suggestion,
  .review-detail,
  .review-row .human-review-note {
    margin-left: 0;
  }
}

/* App hierarchy and one shared assignment surface. */
.human-review{overflow:visible}
.app-review-heading{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:15px}
.app-review-heading h2{font-size:var(--text-lg);margin:0;font-weight:650;display:flex;align-items:baseline;gap:9px;flex-wrap:wrap}.app-review-heading h2 small,.app-review-heading>span{font-size:var(--text-xs);font-weight:400;color:var(--muted)}
.app-review-tools{display:flex;justify-content:flex-end;gap:5px;margin:0 0 8px}
.app-review-columns{display:grid;grid-template-columns:72px minmax(0,1fr) 180px 24px;gap:12px;padding:8px 10px;color:var(--muted);font-size:var(--text-xs)}.app-review-columns>span:first-child{text-align:right}.app-review-columns>span:nth-child(3){text-align:right}
.review-app-header{display:grid;grid-template-columns:minmax(0,1fr) 180px 24px;gap:12px;align-items:center;min-height:45px;border-top:1px solid var(--border);padding:3px 10px}
.review-app-toggle{display:grid;grid-template-columns:62px 14px 18px minmax(0,1fr);align-items:center;gap:12px;width:100%;padding:5px 0;border:0;background:transparent;color:var(--text);text-align:left;cursor:pointer;font:inherit}.review-app-toggle>svg{flex:none;color:var(--muted)}.review-app-toggle>svg.expanded{transform:rotate(90deg)}.review-app-toggle>span{font-weight:600;min-width:0;overflow-wrap:anywhere}.review-app-toggle small{font-weight:400;font-size:var(--text-xs);color:var(--muted);margin-left:7px}
.app-review-duration{font-variant-numeric:tabular-nums;text-align:right;font-weight:500;white-space:nowrap}.review-app-project{text-align:right;color:var(--muted);font-size:var(--text-xs);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.review-app-project.conflict{color:var(--status-warning)}
.review-app-check{display:flex;align-items:center;justify-content:center;min-height:32px;min-width:24px}.review-app-check input{width:15px;height:15px;margin:0;accent-color:var(--accent)}
.review-row{padding:5px 10px;border-color:color-mix(in srgb,var(--border) 55%,transparent)}.review-row::before{display:none}.review-row.picked{background:var(--selected)}
.review-main{grid-template-columns:62px minmax(0,1fr) 180px 24px;gap:12px}.review-main>.app-review-duration{font-size:var(--text-xs);color:var(--muted)}.review-main>.review-what{padding-left:40px}.review-what strong{font-weight:500}.review-state{justify-self:end;border:0;padding:0;max-width:180px;border-radius:0;text-align:right;background:transparent}.review-segment{grid-column:auto}
.review-detail{margin:10px 24px 6px 112px}.review-row .human-review-note{margin-left:112px}.review-suggestion{margin:0;align-items:start}.review-single-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.review-single-actions>.project-picker{min-width:160px}.app-review-more{margin:6px 0 8px 112px}
.app-review-assignment{position:sticky;bottom:8px;z-index:12;display:flex;align-items:center;gap:8px;flex-wrap:wrap;background:var(--panel-raised);border:1px solid var(--border-strong);border-radius:8px;padding:12px;margin:14px 0;box-shadow:0 3px 12px color-mix(in srgb,var(--text) 8%,transparent)}
.app-review-selection{display:grid;gap:3px;min-width:130px;font-size:var(--text-sm)}.app-review-selection small{font-size:var(--text-xs);color:var(--muted)}.app-review-assignment>.project-picker{min-width:170px;flex:1 1 180px}.app-review-assignment .bulk-impact{color:var(--muted);font-size:var(--text-xs)}.app-review-project-shortcuts{display:flex;flex-wrap:wrap;gap:4px;flex-basis:100%}.app-review-project-shortcuts button[aria-pressed=true]{background:var(--selected);color:var(--selected-text)}
@media(max-width:820px){.app-review-columns{grid-template-columns:58px minmax(0,1fr) 115px 24px;gap:8px}.review-app-header{grid-template-columns:minmax(0,1fr) 115px 24px;gap:8px}.review-app-toggle{grid-template-columns:48px 12px 16px minmax(0,1fr);gap:8px}.review-app-toggle small{display:block;margin-left:0}.review-main{grid-template-columns:48px minmax(0,1fr) 115px 24px;gap:8px}.review-main>.review-what{padding-left:28px}.review-state{grid-column:auto;justify-self:end;max-width:115px}.review-detail,.review-row .human-review-note{margin-left:76px}.app-review-more{margin-left:76px}}
@media(max-width:540px){.human-review-body{padding:12px}.app-review-columns{grid-template-columns:46px minmax(0,1fr) 82px 20px;gap:5px;padding:8px 2px}.review-app-header{grid-template-columns:minmax(0,1fr) 82px 20px;gap:5px;padding:3px 2px}.review-app-toggle{grid-template-columns:44px 12px minmax(0,1fr);gap:5px}.review-app-toggle>svg:nth-of-type(2){display:none}.review-app-toggle>span{font-size:12px}.review-row{padding:5px 2px}.review-main{grid-template-columns:44px minmax(0,1fr) 82px 20px;gap:5px}.review-main>.review-what{padding-left:16px}.review-state{font-size:11px;max-width:82px}.review-detail,.review-row .human-review-note{margin-left:0;margin-right:0}.app-review-more{margin-left:0}.app-review-assignment{bottom:4px;padding:10px}.app-review-assignment>.project-picker{min-width:0;flex-basis:100%}}
@media(pointer:coarse){.review-app-header{min-height:48px}.review-app-check{min-height:44px}.review-row{padding-top:7px;padding-bottom:7px}}

</style>
