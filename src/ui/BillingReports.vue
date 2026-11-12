<script setup lang="ts">
import {computed,onMounted,onUnmounted,onActivated,ref} from 'vue';
import type {BillingProject,BillingReport} from '../capture/billing-types.ts';
import type {BillingProgress} from '../capture/billing-progress.ts';
import {request} from './transport.ts';
import {useStore} from './store.ts';
import {humanizeError} from './errors.ts';
import {toast} from './toast.ts';
import LoadingStatus from './LoadingStatus.vue';

const store=useStore();
const projects=ref<BillingProject[]>([]),projectId=ref('');
const loading=ref(true),reporting=ref(false),error=ref('');
type DisplayReport=Omit<BillingReport,'projectSnapshot'>;
const report=ref<DisplayReport|null>(null),cursor=ref<string|null>(null),exportPath=ref('');
const localDate=(date:Date)=>`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
const today=localDate(new Date());
const fromDate=ref(`${today.slice(0,7)}-01`),toDate=ref(today);
let projectRevision=-1,refreshing=false;
async function refresh(background=false){
 if(refreshing)return;refreshing=true;const revision=store.billingProjectRevision.value;
 if(!background)loading.value=true;
 try{
  const result=await request<{projects:BillingProject[]}>('billing_projects');
  projects.value=result.projects;projectRevision=revision;
  if(!projectId.value&&projects.value.length===1)selectProject(projects.value[0]!.id);
 }catch(cause){error.value=humanizeError(cause);}
 finally{refreshing=false;if(!background)loading.value=false;}
}
function selectProject(id:string){
 if(reporting.value||id===projectId.value)return;
 projectId.value=id;report.value=null;cursor.value=null;exportPath.value='';error.value='';
 const first=projects.value.find(p=>p.id===id)?.policies[0]?.effectiveFrom;
 if(first){fromDate.value=first>`${today.slice(0,7)}-01`?first:`${today.slice(0,7)}-01`;if(toDate.value<fromDate.value)toDate.value=fromDate.value;}
}
function configure(){sessionStorage.setItem('agent-time.settings-tab','billing');store.settingsSection.value='billing';store.navigate('settings');}
const countingLabel=(mode:'minutes'|'seconds'|undefined)=>mode==='minutes'?'Minutes per activity block':'Actual seconds';
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

type ReportResponse = { report: DisplayReport; nextCursor: string | null; export?: { path: string; format: string } };
async function loadReport(more = false, format: 'json' | 'csv' | 'markdown' = 'json') {
  if (!projectId.value || reporting.value) return;
  reporting.value = true; error.value = ''; progress.value = null;
  const attempt = ++reportAttempt, progressId = crypto.randomUUID();
  reportOperation.value = more ? 'Loading saved report days' : format !== 'json' ? 'Preparing export' : 'Preparing report';
  watchProgress(progressId, attempt);
  try {
    if (!fromDate.value || !toDate.value || fromDate.value > toDate.value) throw new Error('Choose a valid period with the start date before the end date.');
    const saved = more || format !== 'json' ? report.value : null;
    const result = await request<ReportResponse>('billing_report', { project: projectId.value,
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

onMounted(()=>void refresh());
onActivated(()=>{if(!loading.value&&projectRevision!==store.billingProjectRevision.value)void refresh(true);});
</script>
<template>
  <section class="day-content billing-page">
    <div class="billing-content">
      <header class="day-heading"><div><h1>Billing reports</h1><p>Calculate project billing, review the evidence, and export a saved report.</p></div><button class="btn" @click="configure">Billing settings</button></header>
      <LoadingStatus v-if="loading" label="Loading billing projects" detail="Reading your saved projects and billing rules." />
      <template v-else>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <div v-if="!projects.length" class="empty-state"><h2>Set up your first billing project</h2><p>Group repositories and choose billing rules in Settings before generating a report.</p><button class="btn primary" @click="configure">Configure billing</button></div>
        <div v-else class="project-picker"><label for="report-project">Billable project</label><select id="report-project" :value="projectId" :disabled="reporting" @change="selectProject(($event.target as HTMLSelectElement).value)"><option value="">Choose a project…</option><option v-for="item in projects" :key="item.id" :value="item.id">{{ item.name }}</option></select><button class="btn" :disabled="reporting" @click="refresh(true)">Refresh projects</button></div>
      <section v-if="projectId" class="report-section"><p class="hint">Reports use the saved project settings. Each saved report keeps its original rules and results.</p>
        <form class="period" @submit.prevent="loadReport()"><label>From<input v-model="fromDate" type="date" required :disabled="reporting" /></label><label>Through<input v-model="toDate" type="date" required :min="fromDate" :disabled="reporting" /></label><button class="btn primary" :disabled="reporting">{{ reporting ? 'Working…' : 'Generate report' }}</button></form>
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
    </div>
  </section>
</template>
<style scoped>
.billing-content { max-width: 1100px; margin-bottom: 32px; }
h1 { margin: 0 0 8px; } .day-heading p,.hint,.muted { color: var(--muted); line-height: 1.6; }
.project-picker { display: flex; align-items: center; gap: 12px; margin: 24px 0; } .project-picker select { flex: 1; }
label { display: flex; flex-direction: column; gap: 7px; font-weight: 550; }
input,select { width: 100%; box-sizing: border-box; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); font: inherit; padding: 8px 10px; min-width: 0; }
input:focus-visible,select:focus-visible,summary:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
.primary { background: var(--blue); color: white; } :disabled { opacity: .6; }
.error { padding: 12px; background: var(--status-danger-soft); color: var(--status-danger); border-radius: 6px; line-height: 1.6; }
.explanation { padding: 12px 14px; background: var(--bg); border-left: 2px solid var(--border); line-height: 1.7; color: var(--muted); margin: 14px 0; }
details { margin-top: 16px; } summary { cursor: pointer; color: var(--muted); } ul { padding-left: 20px; line-height: 1.8; }
.empty-state { padding: 24px; border: 1px solid var(--border); border-radius: 10px; background: var(--panel); }
.report-section { margin-top: 34px; } .period { display: flex; gap: 14px; align-items: flex-end; } .period label { flex: 1; } .period .btn { margin-bottom: 1px; } .report-title { display: grid; gap: 6px; margin: 24px 0 14px; } .totals { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; background: var(--border); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; } .totals > div { display: grid; gap: 10px; padding: 16px 12px; background: var(--panel); } .totals span { color: var(--muted); font-size: 11px; } .totals strong { font-size: 16px; overflow-wrap: anywhere; }
.quality { padding: 14px; border: 1px solid var(--border); border-radius: 6px; line-height: 1.7; } .quality ul { margin-bottom: 0; } dl { display: grid; grid-template-columns: 1fr auto; gap: 8px; max-width: 480px; } dt { color: var(--muted); } dd { margin: 0; font-variant-numeric: tabular-nums; }
.table-scroll { overflow: auto; margin-top: 20px; } table { width: 100%; border-collapse: collapse; white-space: nowrap; } caption { text-align: left; font-weight: 650; margin-bottom: 10px; } th, td { padding: 10px 8px; border-bottom: 1px solid var(--border); text-align: right; font-variant-numeric: tabular-nums; } th:first-child { text-align: left; } thead th { color: var(--muted); font-size: 11px; font-weight: 500; } .day-warning { white-space: normal; color: var(--muted); text-align: left; font-size: 11px; line-height: 1.6; }
.report-actions { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 14px; } .report-actions > span { flex: 1; } .export-result { margin-top: 14px; padding: 14px; border: 1px solid var(--border); border-radius: 6px; } code { display: block; overflow-wrap: anywhere; margin: 10px 0; font-size: 11px; }
@media (max-width: 800px) { .grid { grid-template-columns: 1fr; } .totals { grid-template-columns: repeat(2, minmax(0, 1fr)); } .period { flex-wrap: wrap; } .project-picker { flex-wrap: wrap; } }

</style>
