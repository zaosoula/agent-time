<script setup lang="ts">
import AppButton from './AppButton.vue';
import BillingReportExplanation from './BillingReportExplanation.vue';
import SectionHeading from './SectionHeading.vue';
import {computed,onMounted,onUnmounted,onActivated,ref} from 'vue';
import type {BillingProject,BillingReport,BillingReportSummary,BillingHistoryReply} from '../capture/billing-types.ts';
import type {BillingProgress} from '../capture/billing-progress.ts';
import {request} from './transport.ts';
import {useStore} from './store.ts';
import {humanizeError} from './errors.ts';
import {toast} from './toast.ts';
import LoadingStatus from './LoadingStatus.vue';
import {startBackgroundActivity,clearCompletedBackgroundActivities} from './background-activity.ts';

const store=useStore();
const projects=ref<BillingProject[]>([]),projectId=ref('');
const loading=ref(true),reporting=ref(false),error=ref('');
type DisplayReport=Omit<BillingReport,'projectSnapshot'>;
const generatedReport=ref<DisplayReport|null>(null),generatedCursor=ref<string|null>(null),generatedExportPath=ref('');
const view=ref<'generate'|'saved'>('generate');
const savedReport=ref<DisplayReport|null>(null),savedCursor=ref<string|null>(null),savedExportPath=ref('');
const history=ref<BillingReportSummary[]>([]),historyCursor=ref<string|null>(null),historyLoading=ref(false),historyLoaded=ref(false),historyReporting=ref(false),historyError=ref('');
const report=computed(()=>view.value==='saved'?savedReport.value:generatedReport.value);
const cursor=computed(()=>view.value==='saved'?savedCursor.value:generatedCursor.value);
const exportPath=computed(()=>view.value==='saved'?savedExportPath.value:generatedExportPath.value);
const reportBusy=computed(()=>reporting.value||historyReporting.value);
let historyAttempt=0;
async function loadHistory(more=false){
 if(!projectId.value||historyLoading.value)return;
 const id=projectId.value,attempt=++historyAttempt;historyLoading.value=true;historyError.value='';
 try{
  const result=await request<BillingHistoryReply>('billing_report_history',{project:id,...(more&&historyCursor.value?{historyCursor:historyCursor.value}:{})});
  if(attempt!==historyAttempt||id!==projectId.value)return;
  history.value=more?[...history.value,...result.reports]:result.reports;historyCursor.value=result.nextHistoryCursor;historyLoaded.value=true;
 }catch(cause){if(attempt===historyAttempt)historyError.value=humanizeError(cause);}
 finally{if(attempt===historyAttempt)historyLoading.value=false;}
}
function showSaved(){view.value='saved';if(!historyLoaded.value)void loadHistory();}
async function loadSavedReport(item:BillingReportSummary|DisplayReport,more=false,format:'json'|'csv'|'markdown'='json'){
 if(reportBusy.value)return;
 historyReporting.value=true;historyError.value='';
 const activity=startBackgroundActivity(format==='json'?'Opening saved report…':'Exporting report…','billing',()=>{view.value='saved';});
 try{
  const result=await request<ReportResponse>('billing_report',{project:item.projectId,fromDate:item.fromDate,toDate:item.toDate,reportId:item.reportId,format,detail:'daily',...(more&&savedCursor.value?{cursor:savedCursor.value}:{})});
  if(format==='json'){
   savedReport.value=more&&savedReport.value?{...result.report,days:[...savedReport.value.days,...result.report.days]}:result.report;
   savedCursor.value=result.nextCursor;savedExportPath.value='';
  }else savedExportPath.value=result.export?.path||'';
  activity.finish(format==='json'?'Saved report ready':'Report export ready');
 }catch(cause){activity.finish();historyError.value=humanizeError(cause);}
 finally{historyReporting.value=false;}
}
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
 if(reportBusy.value||id===projectId.value)return;
 clearCompletedBackgroundActivities('billing');
 projectId.value=id;generatedReport.value=null;generatedCursor.value=null;generatedExportPath.value='';error.value='';
 historyAttempt++;historyLoading.value=false;historyLoaded.value=false;history.value=[];historyCursor.value=null;savedReport.value=null;savedCursor.value=null;savedExportPath.value='';historyError.value='';if(view.value==='saved')void loadHistory();
 const first=projects.value.find(p=>p.id===id)?.policies[0]?.effectiveFrom;
 if(first){fromDate.value=first>`${today.slice(0,7)}-01`?first:`${today.slice(0,7)}-01`;if(toDate.value<fromDate.value)toDate.value=fromDate.value;}
}
function configure(){store.openProject(undefined,'billing',projectId.value||undefined);}
const countingLabel=(mode:'minutes'|'seconds'|undefined)=>mode==='minutes'?'Minutes per activity block':'Actual seconds';
const progress = ref<BillingProgress | null>(null);
const reportOperation = ref('Preparing report');
let reportActivity:ReturnType<typeof startBackgroundActivity>|undefined;
const progressLabel = computed(() => progress.value?.phase === 'saving' ? 'Saving your report' : progress.value?.date ? `Checking activity for ${progress.value.date}` : reportOperation.value);
const progressDetail = computed(() => progress.value?.totalDays ? `${progress.value.completedDays} of ${progress.value.totalDays} days checked. You can use other sections while this report runs.` : 'Reports run in the background. Large histories can take longer.');
let progressTimer: ReturnType<typeof setTimeout> | undefined;
let reportAttempt = 0;
function stopProgress() { clearTimeout(progressTimer); progressTimer = undefined; }
function watchProgress(progressId: string, attempt: number) {
  const poll = async () => {
    try {
      const next = await request<BillingProgress | null>('billing_report_progress', { progressId });
      if (attempt !== reportAttempt || !reporting.value) return;
      if (next) {progress.value = next;reportActivity?.update(next.totalDays ? `${next.completedDays} of ${next.totalDays} days checked` : next.phase === 'saving' ? 'Saving report' : 'Preparing activity');}
    } catch { /* The report request owns errors; a missed progress update is harmless. */ }
    if (attempt === reportAttempt && reporting.value) progressTimer = setTimeout(poll, 750);
  };
  progressTimer = setTimeout(poll, 400);
}
onUnmounted(() => { reportAttempt++; stopProgress(); });

type ReportResponse = { report: DisplayReport; nextCursor: string | null; export?: { path: string; format: string } };
async function loadReport(more = false, format: 'json' | 'csv' | 'markdown' = 'json') {
  if(view.value==='saved'){if(savedReport.value)await loadSavedReport(savedReport.value,more,format);return;}
  if (!projectId.value || reportBusy.value) return;
  reporting.value = true; error.value = ''; progress.value = null;
  const attempt = ++reportAttempt, progressId = crypto.randomUUID();
  reportOperation.value = more ? 'Loading saved report days' : format !== 'json' ? 'Preparing export' : 'Preparing report';
  reportActivity=startBackgroundActivity(`${reportOperation.value}…`,'billing',()=>{view.value='generate';});
  const activity=reportActivity;
  watchProgress(progressId, attempt);
  try {
    if (!fromDate.value || !toDate.value || fromDate.value > toDate.value) throw new Error('Choose a valid period with the start date before the end date.');
    const saved = more || format !== 'json' ? generatedReport.value : null;
    const result = await request<ReportResponse>('billing_report', { project: projectId.value,
      fromDate: saved?.fromDate || fromDate.value, toDate: saved?.toDate || toDate.value, format, detail: 'daily', progressId,
      ...(saved ? { reportId: saved.reportId } : {}), ...(more && generatedCursor.value ? { cursor: generatedCursor.value } : {}) });
    if (format === 'json') {
      generatedReport.value = more && generatedReport.value ? { ...result.report, days: [...generatedReport.value.days, ...result.report.days] } : result.report;
      generatedCursor.value = result.nextCursor; generatedExportPath.value = '';
    } else generatedExportPath.value = result.export?.path || '';
      activity.finish(format==='json'?'Billing report ready':'Report export ready');
  } catch (cause) { activity.finish(); error.value = humanizeError(cause); }
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
  <section class="day-content app-page billing-page billing-embedded">
    <div class="billing-content">
      <SectionHeading class="day-heading" title="Billing reports" description="Calculate project billing, review the evidence, and export a saved report." :level="2" size="section"><template #actions><AppButton @click="configure">Edit policy</AppButton></template></SectionHeading>
      <LoadingStatus v-if="loading" label="Loading billing projects" detail="Reading your saved projects and billing rules." />
      <template v-else>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <div v-if="!projects.length" class="empty-state"><h2>Set up your first billing project</h2><p>Group repositories and choose billing rules in Projects before generating a report.</p><AppButton variant="primary" @click="configure">Configure billing</AppButton></div>
        <div v-else class="project-picker"><label for="report-project">Billable project</label><select id="report-project" :value="projectId" :disabled="reportBusy" @change="selectProject(($event.target as HTMLSelectElement).value)"><option value="">Choose a project…</option><option v-for="item in projects" :key="item.id" :value="item.id">{{ item.name }}</option></select><AppButton class="btn" :disabled="reportBusy" @click="refresh(true)">Refresh projects</AppButton></div>
      <section v-if="projectId" class="report-section">
        <nav class="report-actions billing-view-tabs" aria-label="Billing report views"><AppButton class="btn" :aria-pressed="view==='generate'" @click="view='generate'">Generate</AppButton><AppButton class="btn" :aria-pressed="view==='saved'" @click="showSaved">Saved reports</AppButton></nav>
        <div v-show="view==='saved'" class="saved-history">
          <p class="hint">Saved reports keep their original rules and totals, even after a policy changes. Most recently saved first.</p>
          <AppButton class="btn" :disabled="historyLoading" @click="loadHistory()">Refresh reports</AppButton>
          <p v-if="historyError" class="error" role="alert">{{ historyError }}</p>
          <LoadingStatus v-if="historyLoading" label="Loading saved reports" />
          <p v-if="!historyLoading&&!history.length" class="hint">No saved reports for this project yet. Generate a report to save it here.</p>
          <ul class="history-list"><li v-for="item in history" :key="item.reportId"><AppButton class="btn" :disabled="reportBusy" @click="loadSavedReport(item)"><strong>{{ item.projectName }} · {{ item.fromDate }} – {{ item.toDate }}</strong><span>Saved {{ new Date(item.createdAt).toLocaleString() }} · {{ duration(item.totals.billableSeconds) }} · {{ item.totals.totalAmount ?? 'Unknown' }} {{ item.currency }}</span><span>{{ (item.countingModes ?? ['seconds']).map(countingLabel).join(' · ') }}</span></AppButton></li></ul>
          <AppButton v-if="historyCursor" class="btn" :disabled="historyLoading" @click="loadHistory(true)">Load more reports</AppButton>
          <p v-if="reporting" class="hint">Your new report is still running. You can open saved reports when it finishes.</p>
          <LoadingStatus v-if="historyReporting" label="Opening saved report" />
        </div>
        <p class="hint">The project, inclusive dates and its configured time zone define the report scope. Generating saves a snapshot of its rules and results; exports reuse that snapshot.</p>
        <form v-show="view==='generate'" class="period" @submit.prevent="loadReport()"><label>From<input v-model="fromDate" type="date" required :disabled="reportBusy" /></label><label>Through<input v-model="toDate" type="date" required :min="fromDate" :disabled="reportBusy" /></label><AppButton variant="primary" :disabled="reportBusy" type="submit">{{ reporting ? 'Working…' : 'Generate and save report' }}</AppButton></form>
        <LoadingStatus v-if="reporting" :label="progressLabel" :detail="progressDetail" :completed="progress?.completedDays" :total="progress?.phase === 'reading' || progress?.phase === 'calculating' ? progress.totalDays : undefined" />
        <template v-if="report"><div class="report-title"><strong>{{ report.projectName }} · {{ report.fromDate }} – {{ report.toDate }}</strong><span class="muted">{{ report.timezone }} · saved {{ new Date(report.createdAt).toLocaleString() }}</span></div>
          <div class="totals"><div><span>Billable time</span><strong>{{ duration(report.totals.billableSeconds) }}</strong></div><div><span>Time amount</span><strong>{{ amount(report.totals.timeAmount) }}</strong></div><div><span>AI fees</span><strong>{{ amount(report.totals.aiAmount) }}</strong></div><div><span>Total</span><strong>{{ amount(report.totals.totalAmount) }}</strong></div></div>
          <BillingReportExplanation :report="report" />

          <div v-if="!report.quality.complete || report.quality.warnings.length" class="quality"><strong>{{ report.quality.complete ? 'Review notes' : 'Incomplete evidence — review before invoicing' }}</strong><ul v-if="report.quality.warnings.length"><li v-for="warning in report.quality.warnings" :key="warning">{{ warning }}</li></ul></div>

          <div class="table-scroll"><table><caption>Daily breakdown</caption><thead><tr><th>Date</th><th>Counting</th><th>Billable</th><th>Time amount</th><th>AI fees</th><th>Total</th></tr></thead><tbody><template v-for="day in report.days" :key="day.date"><tr><th scope="row">{{ day.date }}</th><td>{{ countingLabel(day.countingMode) }}</td><td>{{ duration(day.billableSeconds) }}</td><td>{{ amount(day.timeAmount) }}</td><td>{{ amount(day.aiAmount) }}</td><td>{{ amount(day.totalAmount) }}</td></tr><tr v-if="day.warnings.length"><td colspan="6" class="day-warning">{{ day.warnings.join(' · ') }}</td></tr></template></tbody></table></div>
          <div class="report-actions"><AppButton v-if="cursor" class="btn" :disabled="reportBusy" @click="loadReport(true)">Load more days</AppButton><span class="muted">{{ report.days.length }} days shown</span><AppButton class="btn" :disabled="reportBusy" @click="loadReport(false, 'csv')">Export CSV</AppButton><AppButton class="btn" :disabled="reportBusy" @click="loadReport(false, 'markdown')">Export Markdown</AppButton></div>
          <div v-if="exportPath" class="export-result" role="status"><strong>Export saved</strong><code>{{ exportPath }}</code><AppButton class="btn btn-sm" @click="copyExportPath">Copy path</AppButton><p class="hint">In Finder, press ⇧⌘G and paste this path to find the file.</p></div>
        </template>
      </section>

      </template>
    </div>
  </section>
</template>
<style scoped>
.history-list { list-style: none; padding: 0; } .history-list li { margin: 8px 0; } .history-list button { display: grid; gap: 6px; width: 100%; text-align: left; } .history-list span { color: var(--muted); }
.billing-content { max-width: 1100px; margin-bottom: 32px; }
h1 { margin: 0 0 8px; } .day-heading p,.hint,.muted { color: var(--muted); line-height: 1.6; }
.project-picker { display: flex; align-items: center; gap: 12px; margin: 24px 0; } .project-picker select { flex: 1; }
label { display: flex; flex-direction: column; gap: 7px; font-weight: 550; }
input,select { width: 100%; box-sizing: border-box; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); font-family: inherit; font-size: var(--control-font-size); line-height: var(--control-line-height); padding: var(--control-padding-block) var(--control-padding-inline); min-width: 0; }
input:focus-visible,select:focus-visible,summary:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
.primary { background: var(--blue); color: white; } :disabled { opacity: .6; }
.error { padding: 12px; background: var(--status-danger-soft); color: var(--status-danger); border-radius: 6px; line-height: 1.6; }
.explanation { padding: 12px 14px; background: var(--bg); border-left: 2px solid var(--border); line-height: 1.7; color: var(--muted); margin: 14px 0; }
details { margin-top: 16px; } summary { cursor: pointer; color: var(--muted); } ul { padding-left: 20px; line-height: 1.8; }
.empty-state { padding: 24px; border: 1px solid var(--border); border-radius: 10px; background: var(--panel); }
.report-section { margin-top: 34px; } .period { display: flex; gap: 14px; align-items: flex-end; } .period label { flex: 1; }  .report-title { display: grid; gap: 6px; margin: 24px 0 14px; } .totals { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; background: var(--border); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; } .totals > div { display: grid; gap: 10px; padding: 16px 12px; background: var(--panel); } .totals span { color: var(--muted); font-size: 11px; } .totals strong { font-size: 16px; overflow-wrap: anywhere; }
.quality { padding: 14px; border: 1px solid var(--border); border-radius: 6px; line-height: 1.7; } .quality ul { margin-bottom: 0; } dl { display: grid; grid-template-columns: 1fr auto; gap: 8px; max-width: 480px; } dt { color: var(--muted); } dd { margin: 0; font-variant-numeric: tabular-nums; }
.table-scroll { overflow: auto; margin-top: 20px; } table { width: 100%; border-collapse: collapse; white-space: nowrap; } caption { text-align: left; font-weight: 650; margin-bottom: 10px; } th, td { padding: 10px 8px; border-bottom: 1px solid var(--border); text-align: right; font-variant-numeric: tabular-nums; } th:first-child { text-align: left; } thead th { color: var(--muted); font-size: 11px; font-weight: 500; } .day-warning { white-space: normal; color: var(--muted); text-align: left; font-size: 11px; line-height: 1.6; }
.report-actions { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 14px; } .report-actions > span { flex: 1; } .export-result { margin-top: 14px; padding: 14px; border: 1px solid var(--border); border-radius: 6px; } code { display: block; overflow-wrap: anywhere; margin: 10px 0; font-size: 11px; }
@media (max-width: 800px) { .grid { grid-template-columns: 1fr; } .totals { grid-template-columns: repeat(2, minmax(0, 1fr)); } .period { flex-wrap: wrap; } .project-picker { flex-wrap: wrap; } }

</style>

<style scoped>
.billing-embedded{overflow:visible;flex:none}
</style>
