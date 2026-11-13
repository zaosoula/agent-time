<script setup lang="ts">
import AppCard from './AppCard.vue';
import SectionHeading from './SectionHeading.vue';
import { computed, onMounted, ref, watch } from 'vue';
import type { BillingProject, BillingPolicy } from '../capture/billing-types.ts';
import { request } from './transport.ts';
import { humanizeError } from './errors.ts';
import LoadingStatus from './LoadingStatus.vue';
import {useStore} from './store.ts';
const store=useStore();
import { toast } from './toast.ts';

const props = defineProps<{ selectedProjectId?: string }>();
const emit = defineEmits<{ selected: [id: string] }>();
const saveErrors = new Map<string, string>();
const drafts = new Map<string, { draft: BillingProject; original: BillingProject | null; policy: BillingPolicy; aliases: string; repositories: string; workspaces: string; reportedNames: string }>();
const projects = ref<BillingProject[]>([]), knownSources = ref<string[]>([]);
const loading = ref(true), saving = ref(false), error = ref('');
const draft = ref<BillingProject | null>(null), policy = ref<BillingPolicy | null>(null);
const original = ref<BillingProject | null>(null);
const aliases = ref(''), repositories = ref(''), workspaces = ref(''), reportedNames = ref('');
const localDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const today = localDate(new Date());
const bases = [
  { value: 'overlapMergedWall', label: 'Human + agent shared clock', detail: 'Count simultaneous human and agent work once, across all grouped repositories.' },
  { value: 'humanActive', label: 'Human active time', detail: 'Bill only measured human activity.' },
  { value: 'weightedAgentOnly', label: 'Human + weighted agent-only time', detail: 'Add a fraction of agent time only while no human activity overlaps.' },
  { value: 'weightedAgentRunning', label: 'Human + weighted cumulative agent time', detail: 'Add time from every running agent. Parallel agents can multiply billable time.' },
] as const;
const basisDetail = computed(() => bases.find((basis) => basis.value === policy.value?.basis)?.detail);
const policyChanged = computed(() => {
  if (!policy.value) return false;
  const previous = original.value?.policies.find((item) => item.id === policy.value!.id);
  return !previous || JSON.stringify(previous) !== JSON.stringify(policy.value);
});
const splitLines = (value: string) => [...new Set(value.split('\n').map((line) => line.trim()).filter(Boolean))];
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
function newPolicy(): BillingPolicy {
  return { id: crypto.randomUUID(), effectiveFrom: today, basis: 'overlapMergedWall', countingMode: 'minutes', currency: 'EUR', hourlyRate: null,
    agentOnlyHourlyRate: null, agentWeight: '1', rounding: { minutes: 1, mode: 'nearest', scope: 'period' },
    dailyCapMinutes: null, presenceWindowMinutes: null, aiFees: { mode: 'none' } };
}
function selectProject(project?: BillingProject, fresh = false) {
  const currentKey = original.value?.id || '';
  if (!fresh && draft.value && policy.value) drafts.set(currentKey, clone({ draft: draft.value, original: original.value, policy: policy.value, aliases: aliases.value, repositories: repositories.value, workspaces: workspaces.value, reportedNames: reportedNames.value }));
  error.value = saveErrors.get(project?.id || '') || '';
  const retained = !fresh && drafts.get(project?.id || '');
  if (retained) {
    draft.value = clone(retained.draft); original.value = clone(retained.original); policy.value = clone(retained.policy);
    aliases.value = retained.aliases; repositories.value = retained.repositories; workspaces.value = retained.workspaces; reportedNames.value = retained.reportedNames;
    emit('selected', project?.id || ''); return;
  }
  original.value = project ? clone(project) : null;
  draft.value = project ? clone(project) : { id: '', name: '', aliases: [], sources: { repositories: [], workspaceIds: [], reportedProjects: [] },
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, policies: [] };
  policy.value = clone([...draft.value.policies].reverse().sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0] || newPolicy());
  aliases.value = draft.value.aliases.join('\n'); repositories.value = draft.value.sources.repositories.join('\n');
  workspaces.value = draft.value.sources.workspaceIds.join('\n'); reportedNames.value = draft.value.sources.reportedProjects.join('\n');
  emit('selected', project?.id || '');
}
function selectRequestedProject() {
  if (!props.selectedProjectId || props.selectedProjectId === original.value?.id) return;
  const requested = projects.value.find((item) => item.id === props.selectedProjectId);
  if (requested) selectProject(requested);
}
watch(() => props.selectedProjectId, selectRequestedProject);
async function refresh() {
  loading.value = true;
  try {
    const result = await request<{ projects: BillingProject[]; knownSources: string[] }>('billing_projects', {});
    projects.value = result.projects; knownSources.value = result.knownSources;
    selectRequestedProject();
  } catch (cause) { error.value = humanizeError(cause); }
  finally { loading.value = false; }
}
function setNullableMoney(field: 'hourlyRate' | 'agentOnlyHourlyRate', event: Event) {
  if (policy.value) policy.value[field] = (event.target as HTMLInputElement).value.trim() || null;
}
function setOptionalMinutes(field: 'dailyCapMinutes' | 'presenceWindowMinutes', event: Event) {
  const value = (event.target as HTMLInputElement).value;
  if (policy.value) policy.value[field] = value === '' ? null : Number(value);
}
function setCountingMode(event: Event) {
  if (!policy.value) return;
  const mode = (event.target as HTMLSelectElement).value;
  // Keeping an existing seconds selection must not materialize a legacy omission.
  if (mode === (policy.value.countingMode ?? 'seconds')) return;
  const previous = original.value?.policies.find((item) => item.id === policy.value!.id);
  if (mode === 'seconds' && previous && previous.countingMode === undefined) delete policy.value.countingMode;
  else policy.value.countingMode = mode === 'minutes' ? 'minutes' : 'seconds';
}
const countingLabel = (mode: BillingPolicy['countingMode']) => mode === 'minutes' ? 'Minutes per activity block' : 'Actual seconds';
function setFeeMode(event: Event) {
  if (!policy.value) return;
  const mode = (event.target as HTMLSelectElement).value;
  policy.value.aiFees = mode === 'flat' ? { mode: 'flat', amount: '0', scope: 'period' } : mode === 'actual' ? { mode: 'actual' } : { mode: 'none' };
}
async function save() {
  if (!draft.value || !policy.value || saving.value) return;
  const submittedKey = original.value?.id || '';
  saving.value = true; error.value = ''; saveErrors.delete(submittedKey);
  try {
    new Intl.DateTimeFormat('en', { timeZone: draft.value.timezone }).format();
    const project = clone(draft.value);
    project.id = project.id.trim(); project.name = project.name.trim();
    project.aliases = splitLines(aliases.value);
    project.sources = { repositories: splitLines(repositories.value), workspaceIds: splitLines(workspaces.value), reportedProjects: splitLines(reportedNames.value) };
    project.policies = clone(original.value?.policies || []);
    if (policyChanged.value) {
      const version = clone(policy.value);
      version.id = crypto.randomUUID();
      version.countingMode = policy.value.countingMode ?? 'seconds';
      version.currency = version.currency.trim().toUpperCase();
      project.policies.push(version);
    }
    const saved = await request<BillingProject>('billing_project_save', { project, ...(original.value?.revision === undefined ? {} : { expectedRevision: original.value.revision }) });
    const index = projects.value.findIndex((item) => item.id === saved.id);
    if (index < 0) projects.value.push(saved); else projects.value[index] = saved;
    store.billingProjectRevision.value++;
    drafts.delete(submittedKey); drafts.delete(saved.id);
    if ((original.value?.id || '') === submittedKey) selectProject(saved, true);
    toast.success('Billing project saved.');
  } catch (cause) {
    const message = humanizeError(cause); saveErrors.set(submittedKey, message);
    if ((original.value?.id || '') === submittedKey) error.value = message;
  }
  finally { saving.value = false; }
}
onMounted(refresh);
</script>

<template>
  <section class="billing-settings">
    <SectionHeading title="Billing groups" description="Group related work and configure versioned billing rules. Generate and export calculations from Billing reports." class="heading"><template #actions>
      <button class="btn" :disabled="loading || saving" @click="selectProject()">New billing group</button></template></SectionHeading>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <LoadingStatus v-if="loading" label="Loading billing projects" detail="Reading your saved projects and billing rules." />
    <div v-else class="project-picker"><label for="billing-project">Billing group</label><select id="billing-project" :value="original?.id || ''" :disabled="saving" @change="selectProject(projects.find((item) => item.id === ($event.target as HTMLSelectElement).value))">
      <option value="">{{ projects.length ? 'Choose a billing group…' : 'No groups yet — create your first billing group' }}</option><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option>
    </select><button class="btn btn-sm" :disabled="saving" @click="refresh">Refresh</button></div>
    <template v-if="draft && policy">
      <AppCard as="form" class="editor" @submit.prevent="save">
        <fieldset :disabled="saving"><legend>Project &amp; sources</legend>
          <div class="grid"><label>Group name<input v-model="draft.name" required placeholder="Client project" /></label>
            <label>Timezone<input v-model="draft.timezone" required placeholder="Europe/Paris" /></label><label>Aliases <small>One name per line</small><textarea v-model="aliases" rows="2" /></label></div>
          <p class="hint">Sources grouped here share one billable project clock. Repository roots include their worktrees.</p>
          <div class="grid"><label>Repository roots <small>One full path per line</small><textarea v-model="repositories" rows="3" placeholder="/Users/you/projects/app" /></label>
            </div><details :open="!original"><summary>Technical source identifiers</summary><div class="grid"><label>Project ID<input v-model="draft.id" required :readonly="Boolean(original)" placeholder="client-project" /></label><label>Workspace IDs <small>One ID per line</small><textarea v-model="workspaces" rows="3" /></label><label>Reported project names <small>Exact names, one per line</small><textarea v-model="reportedNames" rows="3" /></label></div></details>
          <details v-if="knownSources.length"><summary>Known sources ({{ knownSources.length }})</summary><ul class="sources"><li v-for="source in knownSources" :key="source">{{ source }}</li></ul></details>
        </fieldset>
        <fieldset :disabled="saving"><legend>Billing policy</legend>
          <p class="hint">Each change creates a new version. A correction can use the same effective date; previous versions and saved reports are kept.</p>
          <div class="grid"><label>Effective from<input v-model="policy.effectiveFrom" type="date" required /></label><label>Billing basis<select v-model="policy.basis"><option v-for="basis in bases" :key="basis.value" :value="basis.value">{{ basis.label }}</option></select></label></div>
          <p class="explanation">{{ basisDetail }} Declared task timers do not automatically become billable time.</p>
          <label>Activity counting<select :value="policy.countingMode ?? 'seconds'" @change="setCountingMode"><option value="minutes">Minutes per activity block</option><option value="seconds">Actual seconds</option></select></label>
          <p class="hint">Minutes round each contiguous eligible activity block up to a minute. Seconds use the actual duration. Exclusions still apply. Commercial rounding below is a separate step.</p>
          <div class="grid"><label>Currency<input v-model="policy.currency" required pattern="[A-Za-z]{3}" maxlength="3" placeholder="EUR" /></label>
            <label>Hourly rate <small>Leave blank if unknown</small><input :value="policy.hourlyRate ?? ''" inputmode="decimal" pattern="[0-9]+(\.[0-9]+)?" placeholder="Unknown" @input="setNullableMoney('hourlyRate', $event)" /></label>
            <template v-if="policy.basis === 'weightedAgentOnly' || policy.basis === 'weightedAgentRunning'"><label>Agent fraction<input v-model="policy.agentWeight" required inputmode="decimal" pattern="([0-9]+(\.[0-9]+)?|[0-9]+/[1-9][0-9]*)" placeholder="1/6" /></label></template>

            <label>Commercial rounding increment<select v-model="policy.rounding.minutes"><option :value="1">1 minute</option><option :value="15">15 minutes</option><option :value="60">1 hour</option></select></label>
            <label>Commercial rounding direction<select v-model="policy.rounding.mode"><option value="nearest">Nearest</option><option value="up">Up</option><option value="down">Down</option></select></label>
            <label>Apply rounding<select v-model="policy.rounding.scope"><option value="period">Once per period</option><option value="day">Each day</option></select></label>


            <label>AI fees<select :value="policy.aiFees.mode" @change="setFeeMode"><option value="none">No AI fees</option><option value="actual">Actual recorded cost</option><option value="flat">Flat fee</option></select></label>
            <template v-if="policy.aiFees.mode === 'flat'"><label>Flat amount<input v-model="policy.aiFees.amount" required inputmode="decimal" pattern="[0-9]+(\.[0-9]+)?" /></label><label>Flat fee applies<select v-model="policy.aiFees.scope"><option value="period">Per period</option><option value="day">Per day</option></select></label></template>
          </div><details class="optional-policy"><summary>Optional billing rules</summary><div class="grid"><label v-if="policy.basis !== 'humanActive'">Agent-only hourly rate <small>Optional; otherwise use hourly rate</small><input :value="policy.agentOnlyHourlyRate ?? ''" inputmode="decimal" pattern="[0-9]+(\.[0-9]+)?" placeholder="Use hourly rate" @input="setNullableMoney('agentOnlyHourlyRate', $event)" /></label><label>Daily cap (minutes) <small>Optional</small><input :value="policy.dailyCapMinutes ?? ''" type="number" min="1" step="1" placeholder="No cap" @input="setOptionalMinutes('dailyCapMinutes', $event)" /></label><label>Recent human-message window (minutes) <small>Optional; requires captured message evidence</small><input :value="policy.presenceWindowMinutes ?? ''" type="number" min="1" step="1" placeholder="No presence gate" @input="setOptionalMinutes('presenceWindowMinutes', $event)" /></label></div></details><p v-if="policy.aiFees.mode === 'actual'" class="hint">Missing, incomplete or unverified costs are flagged. Unknown amounts stay unknown.</p>
          <details v-if="original?.policies.length"><summary>Saved policy versions ({{ original.policies.length }}) · project revision {{ original.revision ?? 0 }}</summary><ul><li v-for="version in [...original.policies].reverse().sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))" :key="version.id">{{ version.effectiveFrom }} · {{ countingLabel(version.countingMode) }} · {{ bases.find((basis) => basis.value === version.basis)?.label }} · {{ version.hourlyRate ?? 'Unknown' }} {{ version.currency }}/h <small>{{ version.id }}</small></li></ul></details>
        </fieldset>
        <footer class="save-row"><span class="muted">{{ original && policyChanged ? 'Saving will append a policy version.' : 'Configuration is saved locally on this Mac.' }}</span><button class="btn btn-primary" type="submit" :disabled="saving">{{ saving ? 'Saving…' : 'Save billing group' }}</button></footer>
      </AppCard>
      <div class="report-link"><p class="hint">Generate and export reports from the dedicated Billing reports page using your saved settings.</p><button class="btn" @click="store.navigate('billing')">Open billing reports</button></div>
    </template>
  </section>
</template>

<style scoped>
.billing-settings { max-width: 920px; font-size: 12px; }
.heading { margin-bottom: var(--space-5); }
h2 { font-size: var(--text-xl); letter-spacing: -.35px; margin: 0 0 8px; } h3 { margin: 0 0 8px; font-size: 15px; }
.heading p, .hint, .muted { color: var(--muted); line-height: 1.6; } .heading p { max-width: 580px; margin: 0; } .hint { margin: 10px 0 14px; }
.project-picker { display: flex; align-items: center; gap: 12px; margin-bottom: 22px; } .project-picker select { flex: 1; min-width: 0; }
.editor { overflow: hidden; }
fieldset { margin: 0; padding: 20px; border: 0; min-width: 0; } fieldset + fieldset { border-top: 1px solid var(--border); } legend { float: left; width: 100%; font-size: 14px; font-weight: 650; margin-bottom: 14px; } legend + * { clear: both; }
.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; } label { display: flex; flex-direction: column; gap: 7px; font-weight: 550; } small { color: var(--muted); font-weight: 400; font-size: 11px; } label small { margin-top: -3px; }
input, select, textarea { width: 100%; box-sizing: border-box; border: 1px solid var(--border); border-radius: var(--control-radius); background: var(--bg); color: var(--text); font: inherit; font-size: var(--control-font-size); line-height: var(--control-line-height); padding: var(--control-padding-block) var(--control-padding-inline); min-width: 0; } input, select { min-height: var(--control-height); } textarea { resize: vertical; font-weight: 400; } input[readonly] { color: var(--muted); } input:focus-visible, select:focus-visible, textarea:focus-visible, summary:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; } :disabled { opacity: .6; }
.explanation { padding: 12px 14px; background: var(--bg); border-left: 2px solid var(--border); line-height: 1.7; color: var(--muted); margin: 14px 0; } .save-row { border-top: 1px solid var(--border); padding: 14px 20px; display: flex; justify-content: space-between; align-items: center; gap: 12px; } details { margin-top: 16px; } summary { cursor: pointer; color: var(--muted); } ul { padding-left: 20px; line-height: 1.8; } li small { display: block; overflow-wrap: anywhere; } .sources { max-height: 180px; overflow: auto; overflow-wrap: anywhere; }
.error { padding: 12px; background: var(--status-danger-soft); color: var(--status-danger); border-radius: 6px; line-height: 1.6; }
.report-link { margin-top: 24px; }
@media (max-width: 800px) { .grid { grid-template-columns: 1fr; } }
</style>
