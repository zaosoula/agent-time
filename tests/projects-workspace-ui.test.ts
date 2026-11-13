import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { computed, reactive, ref, watch, nextTick } from 'vue';
import ts from 'typescript';
import { sessionProject } from '../src/ui/project-identity.ts';
import { humanReviewState } from '../src/capture/human-review.ts';
import type { BillingProject } from '../src/capture/billing-types.ts';

function setup(file: string, globals: Record<string, unknown>, expose: string) {
  const source = readFileSync(new URL(`../src/ui/${file}.vue`, import.meta.url), 'utf8');
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1]!.replace(/^import .*;\n/gm, '');
  const compiled = ts.transpileModule(script, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const all = { computed, reactive, ref, watch, onMounted() {}, defineProps: () => ({}), defineEmits: () => () => {}, ...globals };
  return new Function(...Object.keys(all), `${compiled}; return { ${expose} };`)(...Object.values(all));
}
const project = (id: string): BillingProject => ({ id, name: id, aliases: [], sources: { repositories: ['/repo'], workspaceIds: [], reportedProjects: [] }, timezone: 'UTC', revision: 3, policies: [] });

test('billing group switching retains unsaved rates, source edits and original revision', async () => {
  const props = reactive({ selectedProjectId: '' });
  let reads = 0;
  const state = setup('BillingSettings', {
    defineProps: () => props, useStore: () => ({ billingProjectRevision: ref(0) }), crypto: { randomUUID },
    request: async () => { reads++; return { projects: [project('a'), project('b')], knownSources: [] }; },
    humanizeError: String, toast: { success() {} },
  }, 'selectProject,policy,draft,original,repositories,refresh,projects');
  await state.refresh(); assert.equal(reads, 1);
  props.selectedProjectId = 'a'; await nextTick();
  state.policy.value.hourlyRate = '125'; state.repositories.value = '/repo\n/other'; state.draft.value.name = 'Unsaved client';
  props.selectedProjectId = 'b'; await nextTick(); assert.equal(state.original.value.id, 'b');
  props.selectedProjectId = 'a'; await nextTick();
  assert.equal(state.policy.value.hourlyRate, '125'); assert.equal(state.repositories.value, '/repo\n/other');
  assert.equal(state.draft.value.name, 'Unsaved client'); assert.equal(state.original.value.revision, 3);
  await state.refresh(); assert.equal(state.policy.value.hourlyRate, '125');
  assert.equal(state.projects.value.length, 2);
});

test('website attribution follows explicit repository changes and restores each unfinished pattern', async () => {
  const props = reactive({ project: '/first' });
  const state = setup('WebsiteRules', {
    defineProps: () => props, useStore: () => ({ websiteProjects: ref({ projects: ['/first', '/second'], rules: [], matches: [] }) }),
    humanizeError: String,
  }, 'selected,pattern');
  assert.equal(state.selected.value, '/first'); state.pattern.value = 'https://first.example';
  props.project = '/second'; await nextTick(); assert.equal(state.selected.value, '/second'); assert.equal(state.pattern.value, '');
  state.pattern.value = 'https://second.example'; props.project = '/first'; await nextTick();
  assert.equal(state.pattern.value, 'https://first.example');
  props.project = '/second'; await nextTick(); assert.equal(state.pattern.value, 'https://second.example');
});

test('repository navigation cannot choose a billing group and project sections retain lazy visits', async () => {
  const selectedSessionKey = ref('previous-session');
  const store = { projectsSection: ref('overview'), project: ref('all'), billingSettingsProject: ref('explicit-group'), projects: ref(['/first']), websiteProjects: ref(null), selectedSessionKey, navigate(page: string, path?: string) { assert.equal(page, 'projects'); this.project.value = path!; this.selectedSessionKey.value = ''; } };
  const state = setup('ProjectsPage', { useStore: () => store }, 'chooseRepository,openSection,visited');
  state.chooseRepository('/first'); assert.equal(store.project.value, '/first'); assert.equal(selectedSessionKey.value, ''); assert.equal(store.billingSettingsProject.value, 'explicit-group');
  assert.deepEqual([...state.visited], ['overview']);
  state.openSection('billing'); await nextTick(); state.openSection('overview'); await nextTick();
  assert.deepEqual([...state.visited], ['overview', 'billing']);
  const template = readFileSync(new URL('../src/ui/ProjectsPage.vue', import.meta.url), 'utf8');
  for (const section of ['attribution', 'billing', 'evidence']) {
    assert(template.includes(`v-if="visited.has('${section}')" v-show="store.projectsSection.value === '${section}'"`));
  }
});


test('project overview scopes existing day totals, sessions and unresolved reviews to the selected repository', () => {
  const store = {
    project: ref('/first'), projectsSection: ref('overview'), summaryLoaded: ref(false),
    timelineProjects: ref([{ name: '/first', humanSeconds: 120, agentSeconds: 300 }, { name: '/second', humanSeconds: 60, agentSeconds: 90 }]),
    creditedSessions: ref([{ cwd: '/first', workspaceId: 'local::/first' }, { cwd: '/second', workspaceId: 'local::/second' }]),
    appReviewGroups: ref([{ projectPath: '/first', attributionSource: 'conflict' }, { projectPath: '/first' }, { projectPath: '/second', userAttribution: 'assigned' }, {}]),
  };
  const state = setup('ProjectsPage', { useStore: () => store, sessionProject, humanReviewState }, 'overviewHumanSeconds,overviewAgentSeconds,overviewSessions,overviewReview,overviewPendingReview,overviewHasActivity');
  assert.equal(state.overviewHumanSeconds.value, 120); assert.equal(state.overviewAgentSeconds.value, 300);
  assert.equal(state.overviewSessions.value.length, 1); assert.equal(state.overviewReview.value.length, 2);
  assert.equal(state.overviewPendingReview.value.length, 1); assert.equal(state.overviewHasActivity.value, true);
  store.project.value = 'all';
  assert.equal(state.overviewHumanSeconds.value, 180); assert.equal(state.overviewAgentSeconds.value, 390);
  assert.equal(state.overviewSessions.value.length, 2); assert.equal(state.overviewPendingReview.value.length, 2);
  store.project.value = '/empty'; assert.equal(state.overviewHasActivity.value, false);
  const template = readFileSync(new URL('../src/ui/ProjectsPage.vue', import.meta.url), 'utf8');
  assert(template.includes('v-if="!store.summaryLoaded.value"')); assert(template.includes('v-else>'));
  assert(template.includes('No captured activity for this day')); assert(template.includes('Loading activity for this day…'));
});

for (const fails of [false, true]) test(`billing save completion stays scoped to its submitted group (${fails ? 'failure and retry' : 'success'})`, async () => {
  const props = reactive({ selectedProjectId: '' }), savedRequests: any[] = [];
  let resolveSave!: (value: BillingProject) => void, rejectSave!: (cause: Error) => void;
  const state = setup('BillingSettings', {
    defineProps: () => props, useStore: () => ({ billingProjectRevision: ref(0) }), crypto: { randomUUID },
    request: async (method: string, params: any) => {
      if (method === 'billing_projects') return { projects: [project('a'), project('b')], knownSources: [] };
      savedRequests.push(params);return new Promise((resolve, reject) => { resolveSave = resolve; rejectSave = reject; });
    }, humanizeError: String, toast: { success() {} },
  }, 'refresh,save,policy,draft,original,repositories,error,saving');
  await state.refresh();props.selectedProjectId = 'a';await nextTick();state.policy.value.hourlyRate = '125';state.repositories.value = '/a-edited';
  const saving = state.save();assert.equal(savedRequests[0].project.id, 'a');assert.equal(savedRequests[0].expectedRevision, 3);
  props.selectedProjectId = 'b';await nextTick();state.draft.value.name = 'B unfinished';state.policy.value.hourlyRate = '250';state.repositories.value = '/b-edited';
  if (fails) rejectSave(new Error('A failed'));else resolveSave({ ...savedRequests[0].project, revision: 4 });
  await saving;assert.equal(state.saving.value, false);assert.equal(state.original.value.id, 'b');assert.equal(state.original.value.revision, 3);
  assert.equal(state.draft.value.name, 'B unfinished');assert.equal(state.policy.value.hourlyRate, '250');assert.equal(state.repositories.value, '/b-edited');assert.equal(state.error.value, '');
  props.selectedProjectId = 'a';await nextTick();
  if (fails) {
    assert.equal(state.policy.value.hourlyRate, '125');assert.equal(state.repositories.value, '/a-edited');assert.match(state.error.value, /A failed/);
    const retry = state.save();assert.equal(savedRequests[1].project.id, 'a');assert.equal(savedRequests[1].expectedRevision, 3);resolveSave({ ...savedRequests[1].project, revision: 4 });await retry;
  }
  assert.equal(state.original.value.revision, 4);props.selectedProjectId = 'b';await nextTick();assert.equal(state.draft.value.name, 'B unfinished');assert.equal(state.policy.value.hourlyRate, '250');
});

for (const fails of [false, true]) test(`website rule save retains a newer repository draft (${fails ? 'failure and retry' : 'success'})`, async () => {
  const props = reactive({ project: '/a' }), messages: string[] = [], savedRequests: unknown[][] = [];
  const websiteState = { projects: ['/a', '/b'], rules: [], matches: [] };
  let resolveSave!: (value: unknown) => void, rejectSave!: (cause: Error) => void;
  const state = setup('WebsiteRules', {
    defineProps: () => props, useStore: () => ({ websiteProjects: ref(websiteState) }), humanizeError: String, clearToast() {},
    transport: { setWebsiteRule: (...args: unknown[]) => { savedRequests.push(args);return new Promise((resolve, reject) => { resolveSave = resolve;rejectSave = reject; }); } },
    toast: { success(message: string) { messages.push(message); }, error() {} },
  }, 'selected,pattern,save,busy');
  state.pattern.value = 'https://a.example';const saving = state.save();
  props.project = '/b';await nextTick();state.pattern.value = 'https://b.example';
  if (fails) rejectSave(new Error('A failed'));else resolveSave(websiteState);
  await saving;assert.equal(state.busy.value, false);assert.equal(state.selected.value, '/b');assert.equal(state.pattern.value, 'https://b.example');
  assert.deepEqual(savedRequests[0], ['https://a.example', '/a']);
  if (!fails) assert.equal(messages[0], 'Future visits to https://a.example will count toward a.');
  props.project = '/a';await nextTick();assert.equal(state.pattern.value, fails ? 'https://a.example' : '');
  if (fails) { const retry = state.save();resolveSave(websiteState);await retry;assert.deepEqual(savedRequests[1], ['https://a.example', '/a']);assert.equal(state.pattern.value, ''); }
  props.project = '/b';await nextTick();assert.equal(state.pattern.value, 'https://b.example');
});


test('Projects loads configured repository metadata once on mount without selecting or merging billing groups', async () => {
  const mounted:Array<()=>Promise<void>>=[],calls:Array<[string,unknown]>=[];
  const store={projectsSection:ref('overview'),project:ref('/selected'),billingSettingsProject:ref('explicit-group'),projects:ref<string[]>([]),websiteProjects:ref(null)};
  const configured=project('group');configured.sources.repositories=['/configured','/shared'];
  const second=project('other');second.sources.repositories=['/shared'];
  const state=setup('ProjectsPage',{
    useStore:()=>store,onMounted:(callback:()=>Promise<void>)=>mounted.push(callback),humanizeError:String,
    request:async(name:string,input:unknown)=>{calls.push([name,input]);return {projects:[configured,second],knownSources:['/known','/shared','workspace-id']};},
  },'repositories,refreshRepositoryCatalog,catalogError');
  assert.equal(mounted.length,1);assert.deepEqual(state.repositories.value,['/selected']);
  await mounted[0]!();assert.deepEqual(calls,[['billing_projects',{}]]);
  assert.deepEqual(state.repositories.value,['/configured','/known','/selected','/shared']);
  assert.equal(store.project.value,'/selected');assert.equal(store.billingSettingsProject.value,'explicit-group');
  store.projectsSection.value='billing';await nextTick();store.projectsSection.value='overview';await nextTick();
  assert.equal(calls.length,1);assert.equal(state.catalogError.value,'');
});

test('Projects metadata errors preserve available repository choices and can be retried explicitly', async () => {
  let fail=false,calls=0;
  const store={projectsSection:ref('overview'),project:ref('/selected'),billingSettingsProject:ref('group'),projects:ref(['/today']),websiteProjects:ref(null)};
  const state=setup('ProjectsPage',{
    useStore:()=>store,humanizeError:String,
    request:async()=>{calls++;if(fail)throw new Error('Unavailable');return {projects:[],knownSources:['/configured']};},
  },'repositories,refreshRepositoryCatalog,catalogError,catalogLoading');
  await state.refreshRepositoryCatalog();fail=true;await state.refreshRepositoryCatalog();
  assert.deepEqual(state.repositories.value,['/configured','/selected','/today']);assert.match(state.catalogError.value,/Unavailable/);assert.equal(state.catalogLoading.value,false);
  fail=false;await state.refreshRepositoryCatalog();assert.equal(state.catalogError.value,'');assert.equal(calls,3);
  assert.equal(store.project.value,'/selected');assert.equal(store.billingSettingsProject.value,'group');
});
