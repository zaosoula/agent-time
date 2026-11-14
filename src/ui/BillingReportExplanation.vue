<script setup lang="ts">
import {computed} from 'vue';
import type {BillingReport} from '../capture/billing-types.ts';
const props=defineProps<{report:Pick<BillingReport,'totals'|'countingModes'|'explanation'|'calculationVersion'|'currency'>}>();
const hours=(seconds:number)=>`${(seconds/3600).toLocaleString(undefined,{maximumFractionDigits:2})} h`;
const seconds=(value:number)=>`${value.toLocaleString(undefined,{maximumFractionDigits:3})} seconds`;
const modes=computed(()=>(props.report.countingModes??['seconds']).map(mode=>mode==='minutes'?'One started minute per eligible activity block':'Actual captured seconds').join(' · '));
const sources=computed(()=>[
 {label:'Human active',value:props.report.totals.humanActiveSeconds,detail:'Captured human activity attributed to this project.'},
 {label:'Agent wall time',value:props.report.totals.agentWallSeconds,detail:'Clock time with at least one agent working.'},
 {label:'Cumulative agent time',value:props.report.totals.agentRunningSeconds,detail:'Every execution added up; parallel agents can exceed clock time.'},
 {label:'Shared clock',value:props.report.totals.overlapMergedWallSeconds,detail:'Human and agent activity merged so simultaneous work counts once.'},
]);
</script>
<template>
 <section class="report-explanation" aria-label="How this report is calculated">
  <h3>From activity to billable time</h3>
  <p>Captured human and agent activity is matched to this billing project's sources. The saved policy chooses the time basis. Reported task timers are not added as another layer of time.</p>
  <div class="report-sources"><div v-for="source in sources" :key="source.label"><span>{{source.label}}</span><strong :title="seconds(source.value)">{{hours(source.value)}}</strong><small>{{source.detail}}</small></div></div>
  <ol class="calculation-steps">
   <li><span>Eligible captured time<small>After the saved policy's eligibility rules</small></span><strong :title="seconds(report.totals.rawEligibleSeconds??report.totals.eligibleSeconds)">{{hours(report.totals.rawEligibleSeconds??report.totals.eligibleSeconds)}}</strong></li>
   <li><span>Activity counting adjustment<small>{{modes}}</small></span><strong :title="seconds(report.totals.countingAdjustmentSeconds??0)">{{hours(report.totals.countingAdjustmentSeconds??0)}}</strong></li>
   <li><span>Before commercial rounding</span><strong :title="seconds(report.totals.eligibleSeconds)">{{hours(report.totals.eligibleSeconds)}}</strong></li>
   <li><span>Commercial rounding adjustment<small>Applied using the saved policy; daily caps remain hard limits</small></span><strong :title="seconds(report.totals.roundingSeconds)">{{hours(report.totals.roundingSeconds)}}</strong></li>
   <li class="billable-step"><span>Billable time</span><strong :title="seconds(report.totals.billableSeconds)">{{hours(report.totals.billableSeconds)}}</strong></li>
  </ol>
  <details><summary>Coverage and calculation details</summary>
   <p>These coverage figures describe the whole report period. They are not additional deductions from the billable total above.</p>
   <dl><dt>Exclusion windows</dt><dd>{{hours(report.totals.excludedSeconds)}}</dd><dt>Unknown coverage</dt><dd>{{hours(report.totals.unknownSeconds)}}</dd><dt>Cross-project overlap</dt><dd>{{hours(report.totals.crossProjectOverlapSeconds)}}</dd><dt>Agent-only wall time</dt><dd>{{hours(report.totals.agentOnlyWallSeconds)}}</dd><dt>Known AI cost</dt><dd>{{report.totals.aiKnownAmount}} {{report.currency||''}}</dd><dt>Calculation version</dt><dd>{{report.calculationVersion}}</dd></dl>
   <p>{{report.explanation}}</p>
  </details>
  <p class="snapshot-note">This is a saved calculation snapshot. Exporting uses these same results; changing a policy does not rewrite this report.</p>
 </section>
</template>
<style scoped>
.report-explanation{margin:20px 0;border:1px solid var(--border);border-radius:var(--radius-card);padding:20px;background:var(--panel)}h3{margin:0 0 8px;font-size:var(--text-base)}p,small{color:var(--muted);line-height:1.6;font-size:var(--text-sm)}.report-sources{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin:20px 0}.report-sources>div{display:grid;gap:6px}.report-sources span{font-size:var(--text-sm);color:var(--muted)}.report-sources strong{font-size:var(--text-lg);font-variant-numeric:tabular-nums}.calculation-steps{list-style:none;padding:0;margin:16px 0}.calculation-steps li{display:flex;justify-content:space-between;gap:16px;padding:10px 0;border-top:1px solid var(--border);font-size:var(--text-sm)}.calculation-steps small{display:block;font-size:var(--text-xs);margin-top:3px}.calculation-steps strong{white-space:nowrap;font-variant-numeric:tabular-nums}.billable-step{font-weight:600;color:var(--accent-text)}summary{cursor:pointer;color:var(--muted);font-size:var(--text-sm)}summary:focus-visible{outline:2px solid var(--accent)}dl{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;font-size:var(--text-sm)}dd{margin:0}.snapshot-note{margin-bottom:0}@media(max-width:800px){.report-sources{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:480px){.report-explanation{padding:14px}.report-sources{grid-template-columns:1fr}}
</style>
