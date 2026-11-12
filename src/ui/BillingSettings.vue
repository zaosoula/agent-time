<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { BillingProject, BillingPolicy, BillingReport } from '../capture/billing-types.ts';
import { request } from './transport.ts';
import { humanizeError } from './errors.ts';
import LoadingStatus from './LoadingStatus.vue';
import type { BillingProgress } from '../capture/billing-progress.ts';
import { toast } from './toast.ts';

const projects = ref<BillingProject[]>([]), knownSources = ref<string[]>([]);
const progress = ref<BillingProgress | null>(null);
const reportOperation = ref('Preparing report');
const progressLabel = computed(() => progress.value?.phase === 'saving' ? 'Saving your report' : progress.value?.date ? `Checking activity for ${progress.value.date}` : reportOperation.value);
const progressDetail = computed(() => progress.value?.totalDays ? `${progress.value.completedDays} of ${progress.value.totalDays} days checked. You can use other sections while this report runs.` : 'Reports run in the background. Large histories can take longer.');
let progressTimer: ReturnType<typeof setTimeout> | undefined;
let reportAttempt = 0;
function stopProgress() { clearTimeout(progressTimer); progressTimer = undefined; }
function watchProgress(progressId: string, attempt: number) {
  const poll = async () => {
    try {
      const next = await request<BillingProgress | null>('billing_report_progress', { progressId });
      if (attempt !== reportAttempt) return;
      if (next) progress.value = next;
    } catch { /* The report request owns errors; a missed progress update is harmless. */ }
    if (attempt === reportAttempt && reporting.value) progressTimer = setTimeout(poll, 750);
  };
  progressTimer = setTimeout(poll, 400);
}
onUnmounted(() => { reportAttempt++; stopProgress(); });

const loading = ref(true), saving = ref(false), reporting = ref(false), error = ref('');
const draft = ref<BillingProject | null>(null), policy = ref<BillingPolicy | null>(null);
const original = ref<BillingProject | null>(null);
const aliases = ref(''), repositories = ref(''), workspaces = ref(''), reportedNames = ref('');
type DisplayReport = Omit<BillingReport, 'projectSnapshot'>;
const report = ref<DisplayReport | null>(null), cursor = ref<string | null>(null), exportPath = ref('');
const localDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const today = localDate(new Date());
const fromDate = ref(`${today.slice(0, 7)}-01`), toDate = ref(today);
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
const canReport = computed(() => Boolean(draft.value && original.value && draft.value.id === original.value.id));
const splitLines = (value: string) => [...new Set(value.split('\n').map((line) => line.trim()).filter(Boolean))];
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
function newPolicy(): BillingPolicy {
  return { id: crypto.randomUUID(), effectiveFrom: today, basis: 'overlapMergedWall', countingMode: 'minutes', currency: 'EUR', hourlyRate: null,
    agentOnlyHourlyRate: null, agentWeight: '1', rounding: { minutes: 1, mode: 'nearest', scope: 'period' },
    dailyCapMinutes: null, presenceWindowMinutes: null, aiFees: { mode: 'none' } };
}
function selectProject(project?: BillingProject) {
  original.value = project ? clone(project) : null;
  draft.value = project ? clone(project) : { id: '', name: '', aliases: [], sources: { repositories: [], workspaceIds: [], reportedProjects: [] },
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, policies: [] };
  policy.value = clone([...draft.value.policies].reverse().sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0] || newPolicy());
  if (project?.policies.length) { const first = project.policies[0]!.effectiveFrom; fromDate.value = first > `${today.slice(0, 7)}-01` ? first : `${today.slice(0, 7)}-01`; if (toDate.value < fromDate.value) toDate.value = fromDate.value; }
  aliases.value = draft.value.aliases.join('\n'); repositories.value = draft.value.sources.repositories.join('\n');
  workspaces.value = draft.value.sources.workspaceIds.join('\n'); reportedNames.value = draft.value.sources.reportedProjects.join('\n');
  report.value = null; cursor.value = null; exportPath.value = ''; error.value = '';
}
async function refresh() {
  loading.value = true;
  try {
    const result = await request<{ projects: BillingProject[]; knownSources: string[] }>('billing_projects', {});
    projects.value = result.projects; knownSources.value = result.knownSources;
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
  if (!draft.value || !policy.value) return;
  saving.value = true; error.value = '';
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
    selectProject(saved); toast.success('Billing project saved.');
  } catch (cause) { error.value = humanizeError(cause); }
  finally { saving.value = false; }
}
type ReportResponse = { report: DisplayReport; nextCursor: string | null; export?: { path: string; format: string } };
async function loadReport(more = false, format: 'json' | 'csv' | 'markdown' = 'json') {
  if (!canReport.value || reporting.value) return;
  reporting.value = true; error.value = ''; progress.value = null;
  const attempt = ++reportAttempt, progressId = crypto.randomUUID();
  reportOperation.value = more ? 'Loading saved report days' : format !== 'json' ? 'Preparing export' : 'Preparing report';
  watchProgress(progressId, attempt);
  try {
    if (!fromDate.value || !toDate.value || fromDate.value > toDate.value) throw new Error('Choose a valid period with the start date before the end date.');
    const saved = more || format !== 'json' ? report.value : null;
    const result = await request<ReportResponse>('billing_report', { project: original.value!.id,
      fromDate: saved?.fromDate || fromDate.value, toDate: saved?.toDate || toDate.value, format, detail: 'daily', progressId,
      ...(saved ? { reportId: saved.reportId } : {}), ...(more && cursor.value ? { cursor: cursor.value } : {}) });
    if (format === 'json') {
      report.value = more && report.value ? { ...result.report, days: [...report.value.days, ...result.report.days] } : result.report;
      cursor.value = result.nextCursor; exportPath.value = '';
    } else exportPath.value = result.export?.path || '';
  } catch (cause) { error.value = humanizeError(cause); }
  finally { if (attempt === reportAttempt) { reporting.value = false; stopProgress(); } }
}
async function copyExportPath() {
  try { await navigator.clipboard.writeText(exportPath.value); toast.success('Export path copied.'); }
  catch (cause) { error.value = humanizeError(cause); }
}
const duration = (seconds: number) => `${(seconds / 3600).toLocaleString(undefined, { maximumFractionDigits: 2 })} h`;
const amount = (value: string | null) => value === null ? 'Unknown' : `${value} ${report.value?.currency || ''}`.trim();
onMounted(refresh);
</script>

<template>
  <section class="billing-settings">
    <header class="heading"><div><h2>Project billing</h2><p>Group related work and calculate a reproducible billing report. Saved reports keep their original rules.</p></div>
      <button class="btn" :disabled="loading || saving || reporting" @click="selectProject()">New project</button></header>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <LoadingStatus v-if="loading" label="Loading billing projects" detail="Reading your saved projects and billing rules." />
    <div v-else class="project-picker"><label for="billing-project">Billable project</label><select id="billing-project" :value="original?.id || ''" :disabled="saving || reporting" @change="selectProject(projects.find((item) => item.id === ($event.target as HTMLSelectElement).value))">
      <option value="">{{ projects.length ? 'Choose a project…' : 'No projects yet — create your first project' }}</option><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option>
    </select><button class="btn btn-sm" :disabled="saving || reporting" @click="refresh">Refresh</button></div>
    <template v-if="draft && policy">
      <form class="editor" @submit.prevent="save">
        <fieldset :disabled="saving || reporting"><legend>Project &amp; sources</legend>
          <div class="grid"><label>Project ID<input v-model="draft.id" required :readonly="Boolean(original)" placeholder="client-project" /></label><label>Project name<input v-model="draft.name" required placeholder="Client project" /></label>
            <label>Timezone<input v-model="draft.timezone" required placeholder="Europe/Paris" /></label><label>Aliases <small>One name per line</small><textarea v-model="aliases" rows="2" /></label></div>
          <p class="hint">Sources grouped here share one billable project clock. Repository roots include their worktrees.</p>
          <div class="grid"><label>Repository roots <small>One full path per line</small><textarea v-model="repositories" rows="3" placeholder="/Users/you/projects/app" /></label>
            <label>Workspace IDs <small>One ID per line</small><textarea v-model="workspaces" rows="3" /></label><label>Reported project names <small>Exact names, one per line</small><textarea v-model="reportedNames" rows="3" /></label></div>
          <details v-if="knownSources.length"><summary>Known sources ({{ knownSources.length }})</summary><ul class="sources"><li v-for="source in knownSources" :key="source">{{ source }}</li></ul></details>
        </fieldset>
        <fieldset :disabled="saving || reporting"><legend>Billing policy</legend>
          <p class="hint">Each change creates a new version. A correction can use the same effective date; previous versions and saved reports are kept.</p>
          <div class="grid"><label>Effective from<input v-model="policy.effectiveFrom" type="date" required /></label><label>Billing basis<select v-model="policy.basis"><option v-for="basis in bases" :key="basis.value" :value="basis.value">{{ basis.label }}</option></select></label></div>
          <p class="explanation">{{ basisDetail }} Declared task timers do not automatically become billable time.</p>
          <label>Activity counting<select :value="policy.countingMode ?? 'seconds'" @change="setCountingMode"><option value="minutes">Minutes per activity block</option><option value="seconds">Actual seconds</option></select></label>
          <p class="hint">Minutes round each contiguous eligible activity block up to a minute. Seconds use the actual duration. Exclusions still apply. Commercial rounding below is a separate step.</p>
          <div class="grid"><label>Currency<input v-model="policy.currency" required pattern="[A-Za-z]{3}" maxlength="3" placeholder="EUR" /></label>
            <label>Hourly rate <small>Leave blank if unknown</small><input :value="policy.hourlyRate ?? ''" inputmode="decimal" pattern="[0-9]+(\.[0-9]+)?" placeholder="Unknown" @input="setNullableMoney('hourlyRate', $event)" /></label>
            <template v-if="policy.basis === 'weightedAgentOnly' || policy.basis === 'weightedAgentRunning'"><label>Agent fraction<input v-model="policy.agentWeight" required inputmode="decimal" pattern="([0-9]+(\.[0-9]+)?|[0-9]+/[1-9][0-9]*)" placeholder="1/6" /></label></template>
              <label v-if="policy.basis !== 'humanActive'">Agent-only hourly rate <small>Optional; otherwise use hourly rate</small><input :value="policy.agentOnlyHourlyRate ?? ''" inputmode="decimal" pattern="[0-9]+(\.[0-9]+)?" placeholder="Use hourly rate" @input="setNullableMoney('agentOnlyHourlyRate', $event)" /></label>
            <label>Commercial rounding increment<select v-model="policy.rounding.minutes"><option :value="1">1 minute</option><option :value="15">15 minutes</option><option :value="60">1 hour</option></select></label>
            <label>Commercial rounding direction<select v-model="policy.rounding.mode"><option value="nearest">Nearest</option><option value="up">Up</option><option value="down">Down</option></select></label>
            <label>Apply rounding<select v-model="policy.rounding.scope"><option value="period">Once per period</option><option value="day">Each day</option></select></label>
            <label>Daily cap (minutes) <small>Optional</small><input :value="policy.dailyCapMinutes ?? ''" type="number" min="1" step="1" placeholder="No cap" @input="setOptionalMinutes('dailyCapMinutes', $event)" /></label>
            <label>Recent human-message window (minutes) <small>Optional; requires captured message evidence</small><input :value="policy.presenceWindowMinutes ?? ''" type="number" min="1" step="1" placeholder="No presence gate" @input="setOptionalMinutes('presenceWindowMinutes', $event)" /></label>
            <label>AI fees<select :value="policy.aiFees.mode" @change="setFeeMode"><option value="none">No AI fees</option><option value="actual">Actual recorded cost</option><option value="flat">Flat fee</option></select></label>
            <template v-if="policy.aiFees.mode === 'flat'"><label>Flat amount<input v-model="policy.aiFees.amount" required inputmode="decimal" pattern="[0-9]+(\.[0-9]+)?" /></label><label>Flat fee applies<select v-model="policy.aiFees.scope"><option value="period">Per period</option><option value="day">Per day</option></select></label></template>
          </div><p v-if="policy.aiFees.mode === 'actual'" class="hint">Missing, incomplete or unverified costs are flagged. Unknown amounts stay unknown.</p>
          <details v-if="original?.policies.length"><summary>Saved policy versions ({{ original.policies.length }}) · project revision {{ original.revision ?? 0 }}</summary><ul><li v-for="version in [...original.policies].reverse().sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))" :key="version.id">{{ version.effectiveFrom }} · {{ countingLabel(version.countingMode) }} · {{ bases.find((basis) => basis.value === version.basis)?.label }} · {{ version.hourlyRate ?? 'Unknown' }} {{ version.currency }}/h <small>{{ version.id }}</small></li></ul></details>
        </fieldset>
        <footer class="save-row"><span class="muted">{{ original && policyChanged ? 'Saving will append a policy version.' : 'Configuration is saved locally on this Mac.' }}</span><button class="btn primary" type="submit" :disabled="saving || reporting">{{ saving ? 'Saving…' : 'Save project' }}</button></footer>
      </form>
      <section v-if="canReport" class="report-section"><h3>Billing report</h3><p class="hint">Reports use saved project settings. Save your edits before generating a new report.</p>
        <form class="period" @submit.prevent="loadReport()"><label>From<input v-model="fromDate" type="date" required :disabled="reporting" /></label><label>Through<input v-model="toDate" type="date" required :min="fromDate" :disabled="reporting" /></label><button class="btn primary" :disabled="reporting || saving">{{ reporting ? 'Working…' : 'Generate report' }}</button></form>
        <LoadingStatus v-if="reporting" :label="progressLabel" :detail="progressDetail" :completed="progress?.completedDays" :total="progress?.phase === 'reading' || progress?.phase === 'calculating' ? progress.totalDays : undefined" />
        <template v-if="report"><div class="report-title"><strong>{{ report.projectName }} · {{ report.fromDate }} – {{ report.toDate }}</strong><span class="muted">{{ report.timezone }} · saved {{ new Date(report.createdAt).toLocaleString() }}</span></div>
          <div class="totals"><div><span>Billable time</span><strong>{{ duration(report.totals.billableSeconds) }}</strong></div><div><span>Time amount</span><strong>{{ amount(report.totals.timeAmount) }}</strong></div><div><span>AI fees</span><strong>{{ amount(report.totals.aiAmount) }}</strong></div><div><span>Total</span><strong>{{ amount(report.totals.totalAmount) }}</strong></div></div>
          <p class="hint">Activity counting: {{ (report.countingModes ?? ['seconds']).map(countingLabel).join(' · ') }}. Commercial rounding follows the saved policy for each day.</p>
          <p class="explanation">{{ report.explanation }}</p>
          <div v-if="!report.quality.complete || report.quality.warnings.length" class="quality"><strong>{{ report.quality.complete ? 'Review notes' : 'Incomplete evidence — review before invoicing' }}</strong><ul v-if="report.quality.warnings.length"><li v-for="warning in report.quality.warnings" :key="warning">{{ warning }}</li></ul></div>
          <details class="metrics"><summary>Measured time &amp; adjustments</summary><dl><dt>Human active</dt><dd>{{ duration(report.totals.humanActiveSeconds) }}</dd><dt>Agent wall time</dt><dd>{{ duration(report.totals.agentWallSeconds) }}</dd><dt>Agent only</dt><dd>{{ duration(report.totals.agentOnlyWallSeconds) }}</dd><dt>Cumulative agents</dt><dd>{{ duration(report.totals.agentRunningSeconds) }}</dd><dt>Shared clock</dt><dd>{{ duration(report.totals.overlapMergedWallSeconds) }}</dd><dt>Raw eligible time</dt><dd>{{ duration(report.totals.rawEligibleSeconds ?? report.totals.eligibleSeconds) }}</dd><dt>Activity counting adjustment</dt><dd>{{ duration(report.totals.countingAdjustmentSeconds ?? 0) }}</dd><dt>Eligible before commercial rounding</dt><dd>{{ duration(report.totals.eligibleSeconds) }}</dd><dt>Commercial rounding adjustment</dt><dd>{{ duration(report.totals.roundingSeconds) }}</dd><dt>Excluded</dt><dd>{{ duration(report.totals.excludedSeconds) }}</dd><dt>Unknown coverage</dt><dd>{{ duration(report.totals.unknownSeconds) }}</dd><dt>Cross-project overlap</dt><dd>{{ duration(report.totals.crossProjectOverlapSeconds) }}</dd><dt>Known AI cost</dt><dd>{{ amount(report.totals.aiKnownAmount) }}</dd></dl></details>
          <div class="table-scroll"><table><caption>Daily breakdown</caption><thead><tr><th>Date</th><th>Counting</th><th>Billable</th><th>Time amount</th><th>AI fees</th><th>Total</th></tr></thead><tbody><template v-for="day in report.days" :key="day.date"><tr><th scope="row">{{ day.date }}</th><td>{{ countingLabel(day.countingMode) }}</td><td>{{ duration(day.billableSeconds) }}</td><td>{{ amount(day.timeAmount) }}</td><td>{{ amount(day.aiAmount) }}</td><td>{{ amount(day.totalAmount) }}</td></tr><tr v-if="day.warnings.length"><td colspan="6" class="day-warning">{{ day.warnings.join(' · ') }}</td></tr></template></tbody></table></div>
          <div class="report-actions"><button v-if="cursor" class="btn" :disabled="reporting" @click="loadReport(true)">Load more days</button><span class="muted">{{ report.days.length }} days shown</span><button class="btn" :disabled="reporting" @click="loadReport(false, 'csv')">Export CSV</button><button class="btn" :disabled="reporting" @click="loadReport(false, 'markdown')">Export Markdown</button></div>
          <div v-if="exportPath" class="export-result" role="status"><strong>Export saved</strong><code>{{ exportPath }}</code><button class="btn btn-sm" @click="copyExportPath">Copy path</button><p class="hint">In Finder, press ⇧⌘G and paste this path to find the file.</p></div>
        </template>
      </section>
    </template>
  </section>
</template>

<style scoped>
.billing-settings { max-width: 920px; font-size: 12px; }
.heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; margin-bottom: 22px; }
h2 { font-size: var(--text-xl); letter-spacing: -.35px; margin: 0 0 8px; } h3 { margin: 0 0 8px; font-size: 15px; }
.heading p, .hint, .muted { color: var(--muted); line-height: 1.6; } .heading p { max-width: 580px; margin: 0; } .hint { margin: 10px 0 14px; }
.project-picker { display: flex; align-items: center; gap: 12px; margin-bottom: 22px; } .project-picker select { flex: 1; min-width: 0; }
.editor { border: 1px solid var(--border); border-radius: 10px; background: var(--panel); overflow: hidden; }
fieldset { margin: 0; padding: 20px; border: 0; min-width: 0; } fieldset + fieldset { border-top: 1px solid var(--border); } legend { float: left; width: 100%; font-size: 14px; font-weight: 650; margin-bottom: 14px; } legend + * { clear: both; }
.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; } label { display: flex; flex-direction: column; gap: 7px; font-weight: 550; } small { color: var(--muted); font-weight: 400; font-size: 11px; } label small { margin-top: -3px; }
input, select, textarea { width: 100%; box-sizing: border-box; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); font: inherit; padding: 8px 10px; min-width: 0; } textarea { resize: vertical; font-weight: 400; } input[readonly] { color: var(--muted); } input:focus-visible, select:focus-visible, textarea:focus-visible, summary:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; } :disabled { opacity: .6; }
.explanation { padding: 12px 14px; background: var(--bg); border-left: 2px solid var(--border); line-height: 1.7; color: var(--muted); margin: 14px 0; } .save-row { border-top: 1px solid var(--border); padding: 14px 20px; display: flex; justify-content: space-between; align-items: center; gap: 12px; } .primary { background: var(--blue); color: white; } details { margin-top: 16px; } summary { cursor: pointer; color: var(--muted); } ul { padding-left: 20px; line-height: 1.8; } li small { display: block; overflow-wrap: anywhere; } .sources { max-height: 180px; overflow: auto; overflow-wrap: anywhere; }
.error { padding: 12px; background: var(--status-danger-soft); color: var(--status-danger); border-radius: 6px; line-height: 1.6; }
.report-section { margin-top: 34px; } .period { display: flex; gap: 14px; align-items: flex-end; } .period label { flex: 1; } .period .btn { margin-bottom: 1px; } .report-title { display: grid; gap: 6px; margin: 24px 0 14px; } .totals { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; background: var(--border); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; } .totals > div { display: grid; gap: 10px; padding: 16px 12px; background: var(--panel); } .totals span { color: var(--muted); font-size: 11px; } .totals strong { font-size: 16px; overflow-wrap: anywhere; }
.quality { padding: 14px; border: 1px solid var(--border); border-radius: 6px; line-height: 1.7; } .quality ul { margin-bottom: 0; } dl { display: grid; grid-template-columns: 1fr auto; gap: 8px; max-width: 480px; } dt { color: var(--muted); } dd { margin: 0; font-variant-numeric: tabular-nums; }
.table-scroll { overflow: auto; margin-top: 20px; } table { width: 100%; border-collapse: collapse; white-space: nowrap; } caption { text-align: left; font-weight: 650; margin-bottom: 10px; } th, td { padding: 10px 8px; border-bottom: 1px solid var(--border); text-align: right; font-variant-numeric: tabular-nums; } th:first-child { text-align: left; } thead th { color: var(--muted); font-size: 11px; font-weight: 500; } .day-warning { white-space: normal; color: var(--muted); text-align: left; font-size: 11px; line-height: 1.6; }
.report-actions { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 14px; } .report-actions > span { flex: 1; } .export-result { margin-top: 14px; padding: 14px; border: 1px solid var(--border); border-radius: 6px; } code { display: block; overflow-wrap: anywhere; margin: 10px 0; font-size: 11px; }
@media (max-width: 800px) { .grid { grid-template-columns: 1fr; } .totals { grid-template-columns: repeat(2, minmax(0, 1fr)); } .period { flex-wrap: wrap; } .project-picker { flex-wrap: wrap; } }
</style>
