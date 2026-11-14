<script setup lang="ts">
import {matchesActivity} from '../capture/activity-filter.ts';
import ActivityDetailsPanel from './ActivityDetailsPanel.vue';
import AppButton from './AppButton.vue';
import { computed, ref, watch, onMounted, onUnmounted, onActivated, onDeactivated, nextTick, reactive } from 'vue';
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
import { clock, preciseClock, dateTime, duration } from './format.ts';
import { humanizeError } from './errors.ts';
import { windowVisible } from './polling.ts';
import ProjectPicker from './ProjectPicker.vue';
import ReviewTreeRow from './ReviewTreeRow.vue';
import {buildReviewLayout,defaultReviewGrouping,type ReviewLayout,type ReviewGrouping,type ReviewNode} from './review-tree.ts';
import {assignReviewActivity,reviewFocus,reviewAssignmentParts,reviewDrag,reviewDrop,beginReviewDrag} from './review-workspace.ts';
import ReviewViewControls from './ReviewViewControls.vue';
import ReviewTimeline from './ReviewTimeline.vue';
import {reviewAppSections,reviewContextGroups,reviewCheckState,reviewGroupId,reviewSelection,reviewShortcutAllowed,reviewViewGroups,initialReviewState,reviewAssignmentLabel,reviewIsAssigned,reviewCanAssign,reviewContextTitle,reviewVisitTitle,type AppReviewGroup,type ReviewAppSection,type ReviewContextGroup} from './review-apps.ts';

const emit = defineEmits<{
  note: [start: number, end: number, label: string];
}>();
const store = reactive(useStore());
const root = ref<HTMLElement | null>(null);
const bulkPicker = ref<HTMLElement | null>(null);

const choices = ref<Record<string, string>>({}),
  error = ref(''),
  notice = ref(''),
  pending = ref(''),
  viewMode = ref<'queue' | 'reviewed' | 'all'>('queue'),
  filterText = computed({get:()=>store.pageFilters.review.search,set:(value:string)=>{store.pageFilters.review.search=value;}}),
  openApps = ref<Record<string,boolean>>({}),
  appLimits = ref<Record<string,number>>({}),
  openContexts = ref<Record<string,boolean>>({}),
  visitLimits = ref<Record<string,number>>({}),
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
  store.appReviewGroups.filter(
    (group) =>
      matchesActivity({state:'human',start:group.start,end:group.end,proof:'observed',sourceEventIds:[],foregroundName:group.appName,browserDomain:group.browserDomain,browserUrl:group.browserUrl,browserTitle:group.label,hostId:group.hostId,workspaceId:group.projectPath,userAttribution:group.userAttribution,attributionSource:group.attributionSource}, {...store.pageFilters.review,search:''}) &&
      (store.reviewProjectFilter==='all'||(store.reviewProjectFilter==='unassigned'?!reviewIsAssigned(group):reviewIsAssigned(group)&&group.projectPath===store.reviewProjectFilter)) &&
      (!store.reviewSiteFilter ||
      Boolean(
        group.browserUrl?.startsWith(store.reviewSiteFilter) || group.browserOrigin === store.reviewSiteFilter,
      )),
  ),
);
const priority = { conflict: 0, unmatched: 1, captured: 2, reviewed: 3 };
const queue = computed(() =>
  reviewViewGroups(groups.value,'queue').sort((a,b)=>priority[humanReviewState(a)]-priority[humanReviewState(b)]||b.seconds-a.seconds||b.start-a.start),
);
const reviewed = computed(() => reviewViewGroups(groups.value,'reviewed').sort((a,b)=>b.start-a.start));
const matchesFilter = (group: HumanReviewGroup, query: string) =>
  [(group as AppReviewGroup).appName, group.label, group.detail, group.browserUrl, group.browserOrigin, group.projectPath, group.attributionSource, group.attributionReason].some(
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
const children = (app:ReviewAppSection) => app.contexts.slice(0,appLimits.value[app.key]||30);
const visits = (context:ReviewContextGroup) => context.groups.slice(0,visitLimits.value[context.key]||30);
const isContextOpen = (context:ReviewContextGroup) => Boolean(openContexts.value[context.key]);
const allContexts = computed(() => apps.value.flatMap(app=>app.contexts));
const visibleContexts = computed(() => apps.value.flatMap(app=>isAppOpen(app)?children(app):[]));
const visible = computed(() => visibleContexts.value.flatMap(context=>isContextOpen(context)?visits(context):[]));
const selection = computed(() => {
  const selected=activeGroups.value.filter(group=>selectedGroups.value[id(group)]);
  const parts=reviewAssignmentParts(selected);
  return {...parts,groups:selected,seconds:selected.reduce((sum,g)=>sum+g.seconds,0),overLimit:parts.pairs.length+parts.segments.length>10000,hasDecisions:selected.some(g=>Boolean(g.userAttribution))};
});
const bulkGroups = computed(() => selection.value.groups);
const selectedSeconds = computed(() => selection.value.seconds);
const contextMeta = computed(() => new Map(allContexts.value.map(context=>[context.key,reviewCheckState(context.groups,selectedGroups.value)])));
const selectedContextCount = computed(() => [...contextMeta.value.values()].filter(state=>state.checked||state.partial).length);
const queueContextCount = computed(() => reviewContextGroups(queue.value).length);
const reviewedContextCount = computed(() => reviewContextGroups(reviewed.value).length);
const appMeta = computed(() => new Map(apps.value.map(app=>{
  const check=reviewCheckState(app.groups,selectedGroups.value);
  const identities=new Set(app.groups.map(group=>JSON.stringify([group.userAttribution||humanReviewState(group),group.projectPath||''])));
  const conflict=app.groups.some(group=>humanReviewState(group)==='conflict');
  return [app.key,{...check,label:conflict?'Conflicting matches':identities.size===1?stateLabel(app.groups[0]!):'Mixed projects',conflict}] as const;
})));
function toggleApp(app:ReviewAppSection){openApps.value[app.key]=!isAppOpen(app);}
function toggleAllApps(){const all=apps.value.every(isAppOpen);openApps.value=Object.fromEntries(apps.value.map(app=>[app.key,!all]));}
function selectApp(app:ReviewAppSection,checked:boolean){
  if(pending.value)return;
  for(const group of appMeta.value.get(app.key)!.eligible)selectedGroups.value[id(group)]=checked;
}
function selectContext(context:ReviewContextGroup,checked:boolean){
  if(pending.value)return;
  for(const group of contextMeta.value.get(context.key)!.eligible)selectedGroups.value[id(group)]=checked;
}
/** Prepare only this group's eligible visits; the existing Assign button confirms the change. */
async function beginContextAssignment(context: ReviewContextGroup) {
  if (pending.value) return;
  const current = allContexts.value.find(item => item.key === context.key);
  const eligible = current ? reviewCheckState(current.groups, {}).eligible : [];
  if (!eligible.length) return;
  selectedGroups.value = Object.fromEntries(eligible.map(group => [id(group), true]));
  bulkProject.value = '';
  focused.value = context.key;
  await nextTick();
  const picker = bulkPicker.value?.querySelector<HTMLElement>('button[aria-haspopup="listbox"]');
  picker?.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  picker?.focus({ preventScroll: true });
}
function selectVisible(){
  if(pending.value)return;
  selectedGroups.value=Object.fromEntries(visibleContexts.value.flatMap(context=>contextMeta.value.get(context.key)!.eligible).map(group=>[id(group),true]));
}
function toggleContext(context:ReviewContextGroup){openContexts.value[context.key]=!isContextOpen(context);}
async function selectTimeline(groupId:string,additive=false){
  if(pending.value)return;
  const group=activeGroups.value.find(group=>id(group)===groupId);if(!group)return;
  selectedGroups.value=additive?{...selectedGroups.value,[groupId]:!selectedGroups.value[groupId]}:{[groupId]:true};
  await focusGroup(group);
}
watch([viewMode,filterText,()=>store.reviewSiteFilter],()=>{selectedGroups.value={};bulkProject.value='';focused.value='';},{flush:'sync'});
watch(activeGroups,groups=>{
  const valid=new Set(groups.map(id));
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
  for (const group of activeGroups.value) {
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
    openContexts.value = {};
    visitLimits.value = {};
    bulkProject.value = '';
    let initial=initialReviewState(undefined);
    try {initial=initialReviewState(JSON.parse(sessionStorage.getItem(key)||'{}'));}catch{/* Ignore invalid saved review state. */}
    viewMode.value=store.reviewProjectFilter==='all'?initial.viewMode:'all';
    // Search is retained with this page, independently of the selected day.
    focused.value=initial.focused;
  },
  { immediate: true },
);
watch([viewMode, filterText, focused], () =>
  sessionStorage.setItem(
    reviewStateKey.value,
    JSON.stringify({ version:2,viewMode: viewMode.value, filterText: filterText.value, focused: focused.value }),
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
  if (shown && store.page === 'review') void loadProjects();
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
  const rows:ReviewNode[]=[];
  const walk=(nodes:ReviewNode[])=>{for(const node of nodes){rows.push(node);if(renderExpanded.value[node.key])walk(node.children);}};
  walk(visibleTree.value);
  const focusedElement=event.target instanceof Element?event.target.closest('.review-tree-row'):null;
  const focusedKey=focusedElement?.id.replace(/^review-tree-/, '')||focused.value;
  const current=rows.findIndex(row=>row.key===focusedKey),row=rows[current];
  if(row)focused.value=row.key;
  if(event.key==='j'||event.key==='k'){
    event.preventDefault();const index=Math.max(0,Math.min(rows.length-1,current+(event.key==='j'?1:-1)));
    const target=rows[index];if(target){focused.value=target.key;document.getElementById(`review-tree-${target.key}`)?.focus();}return;
  }
  if(event.key===' '&&row){event.preventDefault();selectNode(row,!row.groups.every(g=>selectedGroups.value[id(g)]));return;}
  if(event.key.toLowerCase()==='u'&&row){event.preventDefault();void assignNode(row,null);}

}
function revealContext(context:ReviewContextGroup){
  const app=apps.value.find(app=>app.key===context.groups[0]?.appKey);
  if(!app)return;
  openApps.value[app.key]=true;
  const index=app.contexts.findIndex(item=>item.key===context.key);
  appLimits.value[app.key]=Math.max(appLimits.value[app.key]||30,Math.ceil((index+1)/30)*30);
}
async function focusContext(context:ReviewContextGroup){
  focused.value=context.key;revealContext(context);
  await nextTick();document.getElementById(`review-${context.key}`)?.focus();
}
async function focusGroup(group:HumanReviewGroup){
  const find=(nodes:ReviewNode[],parents:ReviewNode[]=[]):ReviewNode[]|undefined=>{
    for(const node of nodes){
      if(node.kind==='visit'&&node.groups.some(g=>id(g)===id(group)))return [...parents,node];
      const path=find(node.children,[...parents,node]);if(path)return path;
    }
  };
  const path=find(tree.value);if(!path)return;
  for(const node of path.slice(0,-1))expandedTree.value[node.key]=true;
  if(reviewLayout.value==='chronological')chronologicalLimit.value=Math.max(chronologicalLimit.value,Math.ceil((tree.value.findIndex(n=>n.key===path.at(-1)!.key)+1)/100)*100);
  focused.value=path.at(-1)!.key;
  inspectGroup(group as AppReviewGroup);
  await nextTick();document.getElementById(`review-tree-${focused.value}`)?.focus();
}

onMounted(() => {
  window.addEventListener('keydown', keyboard);
  void loadHistory();
  void loadProjects();
});
onActivated(() => window.addEventListener('keydown', keyboard));
onDeactivated(() => window.removeEventListener('keydown', keyboard));
onUnmounted(() => window.removeEventListener('keydown', keyboard));

// ---- Hierarchical review ---------------------------------------------------------------
const expandedTree=ref<Record<string,boolean>>({});
const reviewLayout=ref<ReviewLayout>('unified');
const grouping=ref<ReviewGrouping>({...defaultReviewGrouping});
const chronologicalLimit=ref(100);
const tree=computed(()=>buildReviewLayout(activeGroups.value,reviewLayout.value,grouping.value));
const visibleTree=computed(()=>reviewLayout.value==='chronological'?tree.value.slice(0,chronologicalLimit.value):tree.value);
const renderExpanded=computed(()=>({...Object.fromEntries(tree.value.filter(n=>n.kind==='category').map(n=>[n.key,true])),...expandedTree.value}));
const expansionByLayout=new Map<ReviewLayout,Record<string,boolean>>();
watch(reviewLayout,(next,previous)=>{expansionByLayout.set(previous,expandedTree.value);expandedTree.value=expansionByLayout.get(next)||{};});
const focusedIds=computed(()=>{
 const find=(nodes:ReviewNode[]):ReviewNode|undefined=>{for(const node of nodes){if(node.key===focused.value)return node;const match=find(node.children);if(match)return match;}};
 return Object.fromEntries((find(tree.value)?.groups||[]).map(g=>[id(g),true]));
});
function activateNode(node:ReviewNode,event:MouseEvent){
 if(pending.value)return;focused.value=node.key;
 if(event.metaKey||event.ctrlKey||event.shiftKey)selectNode(node,!node.groups.every(g=>selectedGroups.value[id(g)]));
 else selectedGroups.value=Object.fromEntries(node.groups.map(g=>[id(g),true]));
}
function focusNode(node:ReviewNode){focused.value=node.key;}
function clearSelection(){selectedGroups.value={};bulkProject.value='';}

const inspectedId=ref('');
const detailGroup=computed(()=>activeGroups.value.find(g=>id(g)===inspectedId.value));
const selectionSummary=computed(()=>({seconds:selectedSeconds.value,visits:bulkGroups.value.length}));
function toggleNode(key:string){expandedTree.value[key]=!renderExpanded.value[key];}
function selectNode(node:ReviewNode,checked:boolean){if(pending.value)return;for(const group of node.groups)selectedGroups.value[id(group)]=checked;}
function actionGroups(node:ReviewNode){return node.groups.some(g=>selectedGroups.value[id(g)])?bulkGroups.value:node.groups;}
async function assignNode(node:ReviewNode,path:string|null){return assignGroups(actionGroups(node),path);}
async function assignGroups(rows:AppReviewGroup[],path:string|null){
  if(pending.value||!rows.length)return;
  const parts=reviewAssignmentParts(rows);
  if(parts.pairs.length+parts.segments.length>10000){error.value='This selection is too large. Select at most 10,000 recorded intervals.';return;}
  const seconds=rows.reduce((sum,g)=>sum+g.seconds,0),count=rows.length;
  if(await act('tree',date=>assignReviewActivity(rows,path,date,transport.setHumanDecision))){
    notice.value=`${duration(seconds)} · ${count} visits ${path?`assigned to ${name(path)}`:'left unassigned'}. Undo restores previous assignments.`;
    selectedGroups.value={};bulkProject.value='';inspectedId.value='';
  }
}
function dragNode(node:ReviewNode,event:DragEvent){if(pending.value||!event.dataTransfer)return;beginReviewDrag(store.selectedDate,actionGroups(node),event.dataTransfer);}
function inspectGroup(group:AppReviewGroup){inspectedId.value=id(group);openRows.value[id(group)]=true;}
watch(()=>store.reviewProjectFilter,()=>{viewMode.value='all';selectedGroups.value={};expandedTree.value={};expansionByLayout.clear();chronologicalLimit.value=100;inspectedId.value='';});
watch(()=>store.selectedDate,()=>{expandedTree.value={};expansionByLayout.clear();chronologicalLimit.value=100;inspectedId.value='';reviewDrag.value=null;});
watch(reviewDrop,request=>{
  if(!request||store.page!=='review'||request.date!==store.selectedDate)return;
  const ids=new Set(request.ids),rows=activeGroups.value.filter(g=>ids.has(id(g)));
  if(rows.length!==ids.size){error.value='The activity changed during the drag. Select it again.';return;}
  void assignGroups(rows,request.project);
});
watch(reviewFocus,request=>{
 if(!request||store.page!=='review'||request.date!==store.selectedDate)return;
 viewMode.value='all';
 selectedGroups.value=Object.fromEntries(request.ids.map(id=>[id,true]));
 if(request.ids.length===1)inspectedId.value=request.ids[0]!;
},{immediate:true});
function selectVisibleTree(){selectedGroups.value=Object.fromEntries(activeGroups.value.map(g=>[id(g),true]));}
function toggleTree(){const open=tree.value.some(n=>!expandedTree.value[n.key]);expandedTree.value=Object.fromEntries(tree.value.map(n=>[n.key,open]));}
// ---- Decisions ----------------------------------------------------------------------------
async function bulkAssign(){return bulkDecide('assigned');}
async function bulkDecide(mode:'assigned'|'unassigned'){
  if(mode==='assigned'&&!bulkProject.value){error.value='Choose a project folder first.';return;}
  return assignGroups(bulkGroups.value,mode==='assigned'?bulkProject.value:null);
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
  if(mode==='assigned'&&!reviewCanAssign(group,path!)){
    if(saveFuture)await saveRule(group);
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
  return detail === group.label || detail === reviewContextTitle(group as AppReviewGroup) ? '' : detail;
}
function rowState(group: HumanReviewGroup) {
  return group.userAttribution ? 'decided' : humanReviewState(group);
}
const stateLabel=reviewAssignmentLabel;

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
      <ReviewTimeline :date="store.selectedDate" :intervals="intervals" :groups="activeGroups" :selected="selectedGroups" :focused-ids="focusedIds" @select="selectTimeline" />
      <div class="app-review-heading"><h2 id="human-review-title">Your Mac activity <small>{{ duration(observedSeconds) }} {{ viewMode==='queue'?'needs a project':'observed' }}</small></h2><span>{{ apps.length }} apps</span></div>
      <p class="app-review-explanation">Estimated active time in your foreground apps. Automatically assigned time already counts toward its project; no confirmation is needed.</p>
      <div class="human-review-controls" role="group" aria-label="Activity view">
        <button :class="{active:viewMode==='queue'}" :aria-pressed="viewMode==='queue'" @click="viewMode=viewMode==='queue'?'all':'queue'">Needs review only</button>
        <span class="badge info">{{store.reviewProjectFilter==='all'?'All activity':store.reviewProjectFilter==='unassigned'?'Unassigned':name(store.reviewProjectFilter)}}</span>
        <span v-if="store.reviewSiteFilter" class="badge info">{{ store.reviewSiteFilter }}<AppButton compact variant="quiet" @click="store.reviewSiteFilter=''">Clear filter</AppButton></span>

      </div>
      <ReviewViewControls v-model:layout="reviewLayout" v-model:grouping="grouping" />
      <p v-if="reviewLayout==='category'" class="app-review-explanation">Applications, websites and pages are different views of the same visits. Their totals are not added together; selecting a visit in one also selects it in the others.</p>
      <p v-if="reviewLayout==='chronological'" class="app-review-explanation">Individual visits in time order. Each row keeps its recorded boundaries; gaps are not filled.</p>
      <div class="review-selection-summary" aria-live="polite"><span>{{activeGroups.length}} visits · {{duration(observedSeconds)}} in this view<template v-if="bulkGroups.length"> · <strong>{{bulkGroups.length}} selected · {{duration(selectedSeconds)}}</strong></template></span><AppButton v-if="bulkGroups.length" compact variant="quiet" @click="clearSelection">Clear selection</AppButton></div>
      <div class="app-review-tools"><AppButton compact variant="quiet" :disabled="!apps.length" @click="toggleTree">Expand / collapse groups</AppButton><AppButton compact variant="quiet" :disabled="Boolean(pending)||!activeGroups.length" @click="selectVisibleTree">Select filtered activity</AppButton></div>
      <p v-if="pending" class="human-review-notice" role="status">Saving assignments and refreshing activity…</p>
      <p v-if="error" class="human-review-error" role="alert">{{ error }} <AppButton compact variant="quiet" @click="error=''">Dismiss</AppButton></p>
      <p v-if="notice" class="human-review-notice" role="status">{{ notice }}<AppButton compact v-if="undoAvailable"  :disabled="Boolean(pending)" @click="undo(dayHistory.find(action=>action.canUndo)!)">Undo ⌘Z</AppButton><AppButton compact variant="quiet" @click="notice=''">Dismiss</AppButton></p>
      <div v-if="!store.summaryLoaded" class="human-review-empty" aria-hidden="true"><span v-for="index in 3" :key="index" class="skeleton" style="height:38px;margin:6px 0" /></div>
      <div v-else-if="!apps.length" class="human-review-empty">{{ filterText?'No activity matches this filter.':store.reviewSiteFilter?'No recorded activity for this site on this day.':viewMode==='all'?'No activity in this project on this day.':viewMode==='reviewed'?'No activity is assigned to a project yet.':'No activity needs a project. Choose All activity to see assigned time.' }}</div>
      <div v-else class="review-tree-list" aria-label="Activity hierarchy">
        <ReviewTreeRow v-for="node in visibleTree" :key="node.key" :node="node" :date="store.selectedDate" :expanded="renderExpanded" :show-assignment="reviewLayout!=='unified'||!grouping.byProject" :focused="focused" :selected="selectedGroups" :projects="projectPaths" :busy="Boolean(pending)" :selection-summary="selectionSummary" @focus="focusNode" @activate="activateNode" @toggle="toggleNode" @select="selectNode" @assign="assignNode" @inspect="inspectGroup" @drag="dragNode" />
      </div>
      <AppButton v-if="reviewLayout==='chronological'&&visibleTree.length<tree.length" compact variant="quiet" @click="chronologicalLimit+=100">Show next {{Math.min(100,tree.length-visibleTree.length)}} visits · {{tree.length-visibleTree.length}} remaining</AppButton>
      <ActivityDetailsPanel v-if="detailGroup" :key="id(detailGroup)" :target="{kind:'human',date:store.selectedDate,groups:[detailGroup]}" @close="inspectedId=''">
        <template v-for="group in [detailGroup]" :key="id(group)">
<div class="review-detail">
<p v-if="reviewIsAssigned(group)" class="review-attribution-note">Already counted in {{ name(group.projectPath!) }}. No confirmation is needed.</p>
<div v-if="!group.reviewSegment" class="review-single-actions">
  <ProjectPicker :model-value="selected(group)" :paths="projectPaths" :label="`Project for ${reviewVisitTitle(group)}`" @update:model-value="choices[id(group)]=$event;rulePreview=''" />
  <AppButton compact :disabled="Boolean(pending)||!reviewCanAssign(group,selected(group))" @click="decide(group,'assigned')">{{ reviewIsAssigned(group)?'Change project':`Assign ${duration(group.seconds)}` }}</AppButton>
  <AppButton compact :disabled="Boolean(pending)" @click="decide(group,'unassigned')">Leave unassigned</AppButton>
</div>
        <div v-if="suggestion(group) && !group.userAttribution && !reviewIsAssigned(group)" class="review-suggestion">
          <span>
            Suggested <strong>{{ name(suggestion(group)!.projectPath) }}</strong> ·
            {{ suggestion(group)!.source.replaceAll('_', ' ') }} · {{ suggestion(group)!.detail }}
          </span>
          <AppButton compact :disabled="Boolean(pending)" @click="assignSuggestion(group)">
            Assign {{ duration(group.seconds) }}
          </AppButton>
        </div>

          <details class="review-secondary">
            <summary>Split, notes &amp; matching details</summary>
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
            <AppButton compact variant="quiet" v-if="!group.reviewSegment && group.userAttribution"  :disabled="Boolean(pending)" @click="decide(group,'clear')"><RotateCcw :size="12" /> Reset to automatic match</AppButton>
            <template v-if="!group.reviewSegment">
              <AppButton compact
                v-if="group.end - group.start >= 2"
                class="btn btn-sm"
                :disabled="Boolean(pending)"
                @click="openSplit(group)"
              >
                Split between projects…
              </AppButton>
            </template>
            <template v-else>
              <AppButton compact :disabled="Boolean(pending)" @click="openSplit(group)">Change split…</AppButton>
              <AppButton compact :disabled="Boolean(pending)" @click="decide(group, 'clear')">
                Remove split
              </AppButton>
            </template>
            <AppButton compact @click="emit('note', group.start, group.end, group.label)">Add note</AppButton>
          </div>
          </details>
          <div v-if="splitDraft?.key === id(group)" class="human-review-split">
            <strong>Divide {{ reviewVisitTitle(group) }}</strong>
            <label>
              Split at {{ clock(splitDraft.at) }}
              <input
                v-model.number="splitDraft.at"
                type="range"
                :min="Math.ceil(splitDraft.start + 1)"
                :max="Math.floor(splitDraft.end - 1)"
                step="1"
                :aria-label="`Split time for ${reviewVisitTitle(group)}`"
              />
            </label>
            <div>
              <span>Before</span>
              <ProjectPicker v-model="splitDraft.before" :paths="projectPaths" label="Project before split" />
              <AppButton compact @click="splitDraft.before = ''">Leave unassigned</AppButton>
            </div>
            <div>
              <span>After</span>
              <ProjectPicker v-model="splitDraft.after" :paths="projectPaths" label="Project after split" />
              <AppButton compact @click="splitDraft.after = ''">Leave unassigned</AppButton>
            </div>
            <p>
              The original recording stays unchanged. The two parts need different projects, or one can stay
              unassigned.
            </p>
            <AppButton compact variant="primary"
              :disabled="Boolean(pending) || splitDraft.before === splitDraft.after"
              @click="saveSplit(group)"
            >
              Save split
            </AppButton>
            <AppButton compact @click="splitDraft = null">Cancel</AppButton>
          </div>
          <details v-if="futurePatterns(group).length" class="review-secondary">
            <summary>Rules for future visits</summary>
          <div class="human-review-future">
            <label>
              Future visits
              <select
                class="control-compact"
                :value="futurePattern(group)"
                @change="choosePattern(group, ($event.target as HTMLSelectElement).value)"
              >
                <option v-for="pattern in futurePatterns(group)" :key="pattern" :value="pattern">
                  {{ pattern }}
                </option>
              </select>
            </label>
            <AppButton compact :disabled="Boolean(pending) || !selected(group)" @click="previewRule(group)">
              Preview future rule
            </AppButton>
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
              <AppButton compact variant="primary"
                v-if="!group.userAttribution&&!reviewIsAssigned(group)"

                :disabled="Boolean(pending) || !previewReady(group)"
                @click="decide(group, 'assigned', true)"
              >
                Assign activity and save future rule
              </AppButton>
              <AppButton compact variant="primary"
                v-else

                :disabled="Boolean(pending) || !previewReady(group)"
                @click="saveRule(group)"
              >
                Save future rule
              </AppButton>
            </div>
          </div>
          </details>
        </div>

        </template>
      </ActivityDetailsPanel>
      <div v-if="bulkGroups.length" class="app-review-assignment review-selection-toolbar" aria-label="Assign selected activity">
        <div class="app-review-selection" aria-live="polite"><strong>{{ bulkGroups.length }} {{ bulkGroups.length===1?'visit':'visits' }} · {{ duration(selectedSeconds) }}</strong><small>{{ bulkGroups.length }} {{ bulkGroups.length===1?'visit':'visits' }} selected</small></div>
        <p class="review-confirmation-scope">Selected visits only<template v-if="selectedContextCount===1"> · {{ allContexts.find(context=>contextMeta.get(context.key)?.checked||contextMeta.get(context.key)?.partial)?.label }}</template>. Choose a project, then confirm below.</p>
        <div ref="bulkPicker" class="bulk-project-picker"><ProjectPicker v-model="bulkProject" :paths="projectPaths" label="Project for selected activity" /></div>

        <AppButton compact variant="primary"  :disabled="Boolean(pending)||!bulkProject" @click="bulkAssign">{{ bulkGroups.some(reviewIsAssigned)?'Change project':'Assign' }} {{ duration(selectedSeconds) }}</AppButton>
        <AppButton compact :disabled="Boolean(pending)" @click="bulkDecide('unassigned')">Leave unassigned</AppButton>
        <AppButton compact variant="quiet" :disabled="Boolean(pending)" @click="selectedGroups={}">Clear</AppButton>
        <div v-if="projectPaths.length" class="app-review-project-shortcuts"><AppButton compact variant="quiet" v-for="(path,index) in projectPaths.slice(0,3)" :key="path"  :disabled="Boolean(pending)" :aria-pressed="bulkProject===path" @click="bulkProject=path">{{ index+1 }} {{ name(path) }}</AppButton></div>
      </div>
      <details v-if="dayHistory.length" class="human-review-history">
        <summary>Decision history · {{ dayHistory.length }} recent changes</summary>
        <ol>
          <li v-for="action in dayHistory" :key="action.id">
            {{ dateTime(action.at) }} · {{ action.count }}
            {{ action.count === 1 ? 'recording' : 'recordings' }} {{ historyLabel(action)
            }}{{ action.undoneAt ? ' · undone' : '' }}
            <AppButton compact v-if="action.canUndo"  :disabled="Boolean(pending)" @click="undo(action)">
              Undo
            </AppButton>
          </li>
        </ol>
        <small>An earlier decision can be undone when its activity has not been changed since.</small>
      </details>

      <p class="human-review-shortcuts">J / K navigate · Space select · Right-click or ⋯ to assign · U leave unassigned · ⌘Z undo</p>
    </div>
  </section>
</template>

<style scoped>
.review-context-project { display: flex; flex-direction: column; align-items: flex-end; gap: 5px; min-width: 0; }
.review-context-assign { flex-shrink: 0; }
.review-secondary { margin-top: 14px; }
.review-secondary > summary { cursor: pointer; color: var(--muted); font-size: var(--text-sm); }
.review-secondary > summary:focus-visible { outline: 2px solid var(--blue); outline-offset: 3px; }
.review-confirmation-scope { width: 100%; margin: 0; font-size: var(--text-xs); color: var(--muted); }

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
.human-review-controls > button {
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
.human-review-future {
  display: flex;
  align-items: center;
  gap: 9px;
  flex-wrap: wrap;
  margin-top: 7px;
}
.human-review-future small {
  font-size: var(--text-xs);
  color: var(--muted);
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
  padding: var(--control-padding-block) var(--control-padding-inline);
  border: 1px solid var(--border);
  border-radius: var(--control-radius);
  background: var(--hover);
  color: var(--text);
  font-size: var(--control-font-size);
  line-height: var(--control-line-height);
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
.human-review-row-head {
  font-size: 12px;
}
.human-review-row-head small,
.human-review-evidence,
.human-review-proof,
.human-review-controls > button {
  font-size: 11px;
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
.app-review-selection{display:grid;gap:3px;min-width:130px;font-size:var(--text-sm)}.app-review-selection small{font-size:var(--text-xs);color:var(--muted)}.app-review-assignment>.bulk-project-picker{min-width:170px;flex:1 1 180px}.app-review-assignment .bulk-impact{color:var(--muted);font-size:var(--text-xs)}.app-review-project-shortcuts{display:flex;flex-wrap:wrap;gap:4px;flex-basis:100%}.app-review-project-shortcuts button[aria-pressed=true]{background:var(--selected);color:var(--selected-text)}
@media(max-width:820px){.app-review-columns{grid-template-columns:58px minmax(0,1fr) 115px 24px;gap:8px}.review-app-header{grid-template-columns:minmax(0,1fr) 115px 24px;gap:8px}.review-app-toggle{grid-template-columns:48px 12px 16px minmax(0,1fr);gap:8px}.review-app-toggle small{display:block;margin-left:0}.review-main{grid-template-columns:48px minmax(0,1fr) 115px 24px;gap:8px}.review-main>.review-what{padding-left:28px}.review-state{grid-column:auto;justify-self:end;max-width:115px}.review-detail,.review-row .human-review-note{margin-left:76px}.app-review-more{margin-left:76px}}
@media(max-width:540px){.human-review-body{padding:12px}.app-review-columns{grid-template-columns:46px minmax(0,1fr) 82px 20px;gap:5px;padding:8px 2px}.review-app-header{grid-template-columns:minmax(0,1fr) 82px 20px;gap:5px;padding:3px 2px}.review-app-toggle{grid-template-columns:44px 12px minmax(0,1fr);gap:5px}.review-app-toggle>svg:nth-of-type(2){display:none}.review-app-toggle>span{font-size:12px}.review-row{padding:5px 2px}.review-main{grid-template-columns:44px minmax(0,1fr) 82px 20px;gap:5px}.review-main>.review-what{padding-left:16px}.review-state{font-size:11px;max-width:82px}.review-detail,.review-row .human-review-note{margin-left:0;margin-right:0}.app-review-more{margin-left:0}.app-review-assignment{bottom:4px;padding:10px}.app-review-assignment>.bulk-project-picker{min-width:0;flex-basis:100%}}
@media(pointer:coarse){.review-app-header{min-height:48px}.review-app-check{min-height:44px}.review-row{padding-top:7px;padding-bottom:7px}}

.app-review-explanation{font-size:var(--text-sm);color:var(--muted);margin:-5px 0 15px}
.review-context-section{border-top:1px solid color-mix(in srgb,var(--border) 55%,transparent)}
.review-context{border-top:0}.review-context .review-what strong{font-weight:550}
.review-visit{margin-left:22px;background:color-mix(in srgb,var(--panel-raised) 55%,transparent)}
.review-visit .review-main>.review-what{padding-left:48px}.review-visit .review-main>.app-review-duration{font-size:11px}
@media(max-width:820px){.review-visit{margin-left:12px}.review-visit .review-main>.review-what{padding-left:30px}}
@media(max-width:540px){.review-visit{margin-left:4px}.review-visit .review-main>.review-what{padding-left:16px}}
.review-state{white-space:normal;line-height:1.35;overflow-wrap:anywhere}
.review-row.captured .review-state{color:var(--status-good)}
.review-attribution-note{margin:0;color:var(--status-good);font-size:var(--text-sm)}
.review-selection-summary{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:10px 0;color:var(--muted);font-size:var(--text-sm)}
.review-tree-list{border-top:1px solid var(--border)}
.review-inspector{margin:20px 0;padding:18px;border:1px solid var(--border);border-radius:var(--radius-card)}
.review-inspector-title{display:flex;justify-content:space-between;align-items:center;gap:16px}.review-inspector-title h3{margin:0}
.review-selection-toolbar{position:sticky;bottom:0;z-index:3;background:var(--panel);border:1px solid var(--border);box-shadow:var(--shadow-float)}
.human-review-notice{position:sticky;top:0;z-index:4;background:var(--panel);border:1px solid var(--border);padding:12px;border-radius:var(--radius-inner)}
</style>
