<script setup lang="ts">
import {computed,reactive} from 'vue';
import {ChevronLeft,ChevronRight,X} from '@lucide/vue';
import {useStore} from './store.ts';
import {shiftDate} from './format.ts';
import {projectDisplay} from './project-identity.ts';
import {emptyActivityFilters,type ActivityFilters} from '../capture/activity-filter.ts';
const store=reactive(useStore());
const daily=computed(()=>store.page==='today'||store.page==='review'||store.page==='reports'&&store.reportsSection==='evidence');
const detailed=computed(()=>store.page!=='reports'||store.reportsSection==='time'||store.reportsSection==='evidence');
const facets=computed(()=>store.page!=='reports'||store.reportsSection==='time');
const paths=computed(()=>[...new Set([...store.knownProjects,...store.projects,...(store.websiteProjects?.projects||[]),...(store.project.startsWith('/')?[store.project]:[])])].sort());
const values=(key:'app'|'site'|'device')=>{
 const current=store.activityFilters[key];
 const all=store.dayIntervals.map(i=>key==='app'?(i.foregroundName||i.browserBundleId||i.foregroundBundleId||''):key==='site'?i.browserDomain||'':i.hostId||'local');
 return [...new Set([...(store.page==='reports'&&store.reportsSection==='time'?store.reportFilterOptions[key]:all),current].filter(Boolean))].sort();
};
function update(key:keyof ActivityFilters,value:string){store.setActivityFilters({...store.activityFilters,[key]:value});}
const chips=computed(()=>Object.entries(store.activityFilters).filter(([key,value])=>value&&value!=='all'&&(facets.value||key==='search')));
function clear(){store.setActivityFilters(emptyActivityFilters());if(store.page==='review')store.reviewSiteFilter='';}
</script>
<template>
 <section class="workspace-scope" aria-label="Period and activity filters">
  <div class="scope-row">
   <select aria-label="Filter activity by project" :value="store.project" @change="store.navigate(store.page,($event.target as HTMLSelectElement).value)"><option value="all">All activity</option><option value="unassigned">Unassigned</option><option v-for="path in paths" :key="path" :value="path">{{projectDisplay(path,paths)}}</option></select>
  </div>
  <div v-if="daily&&store.period.from!==store.period.to" class="scope-row day-focus"><span>Day detail within this period</span><button class="icon-button" aria-label="Previous day" :disabled="store.selectedDate<=store.period.from" @click="store.setDate(shiftDate(store.selectedDate,-1))"><ChevronLeft :size="14"/></button><input type="date" aria-label="Choose day" :min="store.period.from" :max="store.period.to" :value="store.selectedDate" @change="store.setDate(($event.target as HTMLInputElement).value)"/><button class="icon-button" aria-label="Next day" :disabled="store.selectedDate>=store.period.to" @click="store.setDate(shiftDate(store.selectedDate,1))"><ChevronRight :size="14"/></button><small>Daily charts, evidence and review actions use this day. Time and billing reports use the full period.</small></div>

  <div v-if="detailed" class="scope-row detail-filters">
   <input type="search" aria-label="Search this page's activity" placeholder="Search activity…" :value="store.activityFilters.search" @input="update('search',($event.target as HTMLInputElement).value)"/>
   <details v-if="facets" class="facet-controls"><summary>Filters</summary><div class="facet-fields"><select v-for="key in ['app','site','device'] as const" :key="key" :aria-label="`Filter by ${key}`" :value="store.activityFilters[key]" @change="update(key,($event.target as HTMLSelectElement).value)"><option value="">{{key==='app'?'All apps':key==='site'?'All websites':'All devices'}}</option><option v-for="value in values(key)" :key="value" :value="value">{{value==='local'?'This Mac':value}}</option></select><select aria-label="Filter by assignment" :value="store.activityFilters.assignment" @change="update('assignment',($event.target as HTMLSelectElement).value)"><option value="all">Any assignment</option><option value="assigned">Assigned human activity</option><option value="unassigned">Unassigned human activity</option></select></div></details>
   <button v-if="chips.length||store.page==='review'&&store.reviewSiteFilter" class="btn btn-sm" @click="clear">Clear filters</button>
  </div>
  <div v-if="detailed&&chips.length" class="scope-chips"><button v-for="[key,value] in chips" :key="key" class="filter-chip" :aria-label="`Remove ${key} filter`" @click="update(key as keyof ActivityFilters,key==='assignment'?'all':'')">{{key}}: {{value}}<X :size="12"/></button></div>
  <p v-if="facets&&(store.activityFilters.app||store.activityFilters.site)" class="scope-hint">App and website filters show captured human activity. Agent execution does not carry a foreground app.</p>
  <p v-if="store.page==='reports'&&store.reportsSection==='billing'" class="scope-hint">The shared period supplies new reports. A billable project includes all its configured repositories; saved reports retain their original scope and totals.</p>
  <p v-if="store.page==='reports'&&store.reportsSection==='usage'" class="scope-hint">Token totals follow the selected period across the account. Repository attribution is unavailable for usage; account limits stay live and model totals cover available history.</p>
 </section>
</template>
<style scoped>
.workspace-scope{padding:14px 30px;border-bottom:1px solid var(--border);background:var(--panel);flex-shrink:0;max-height:45vh;overflow:auto}.scope-row{display:flex;align-items:center;flex-wrap:wrap;gap:8px}.scope-row+.scope-row{margin-top:10px}.scope-row select,.scope-row input{min-width:0;max-width:100%;min-height:var(--control-height,36px);padding:7px 10px;border:1px solid var(--border);border-radius:var(--radius-inner);background:var(--surface);color:var(--text);font:inherit;font-size:var(--text-sm)}.scope-row select{max-width:240px;min-width:145px}.scope-row select[aria-label="Period"]{min-width:92px;flex:0 0 92px}.scope-row select[aria-label="Filter activity by project"]{min-width:180px}.facet-controls{position:relative}.facet-controls summary{cursor:pointer;list-style:none;border:1px solid var(--border);border-radius:var(--radius-inner);padding:8px 12px;font-size:var(--text-sm)}.facet-fields{display:grid;grid-template-columns:repeat(2,minmax(140px,1fr));gap:8px;padding:12px 0 0}.facet-controls[open]{flex-basis:100%}.facet-controls[open] summary{display:inline-block}.facet-fields select{max-width:100%;width:100%}.scope-row input[type=search]{flex:1;min-width:180px}.period-label{font-size:var(--text-sm);font-variant-numeric:tabular-nums}.day-focus{color:var(--muted);font-size:var(--text-sm)}.day-focus small{font-size:var(--text-xs)}label{display:flex;gap:7px;align-items:center;font-size:var(--text-sm)}.scope-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.filter-chip{display:inline-flex;align-items:center;gap:6px;font-size:var(--text-xs);padding:4px 8px;border-radius:var(--radius-inner);background:var(--accent-soft);color:var(--text);max-width:100%;overflow-wrap:anywhere}.scope-hint{font-size:var(--text-xs);color:var(--muted);margin:8px 0 0;line-height:1.5}@media(max-width:760px){.workspace-scope{padding:12px 18px}.scope-row select{flex:1;max-width:100%}}
</style>
