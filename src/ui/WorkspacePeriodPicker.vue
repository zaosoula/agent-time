<script setup lang="ts">
import {reactive,ref,watch} from 'vue';
import {ChevronLeft,ChevronRight} from '@lucide/vue';
import {PopoverContent,PopoverPortal,PopoverRoot,PopoverTrigger} from 'reka-ui';
import {useStore} from './store.ts';
import {dateString} from './format.ts';
import type {PeriodMode} from './workspace-scope.ts';
const store=reactive(useStore());
const from=ref(store.period.from),to=ref(store.period.to),custom=ref(false),error=ref('');
watch(()=>store.period,p=>{from.value=p.from;to.value=p.to;error.value='';});
function mode(event:Event){const value=(event.target as HTMLSelectElement).value as PeriodMode;custom.value=value==='custom';if(!custom.value)store.setPeriodMode(value as Exclude<PeriodMode,'custom'>);}
function apply(){if(store.setPeriod(from.value,to.value)){custom.value=false;error.value='';}else error.value='Choose valid dates, in order, spanning at most 367 days.';}
</script>
<template>
 <div class="workspace-period-picker" role="group" aria-label="Date range">
  <button class="icon-button" aria-label="Previous period" @click="store.shiftPeriod(-1)"><ChevronLeft :size="16"/></button>
  <select aria-label="Period" :value="custom?'custom':store.period.mode" @change="mode"><option value="day">Day</option><option value="week">Week</option><option value="month">Month</option><option value="custom">Custom range</option></select>
  <PopoverRoot v-model:open="custom">
   <PopoverTrigger v-if="store.period.mode!=='day'||custom" as-child><button class="period-label" :aria-label="`Edit period ${store.periodLabel}`">{{store.periodLabel}}</button></PopoverTrigger>
   <input v-else class="period-day" type="date" aria-label="Choose day" :value="store.selectedDate" @change="store.setDate(($event.target as HTMLInputElement).value)"/>
   <PopoverPortal><PopoverContent class="period-editor" aria-label="Choose custom period" side="bottom" align="start" :side-offset="8" :collision-padding="12">
    <form @submit.prevent="apply"><strong>Custom period</strong><label>From<input v-model="from" type="date" required/></label><label>Through<input v-model="to" type="date" :min="from" required/></label><p v-if="error" role="alert">{{error}}</p><div class="period-editor-actions"><button class="btn btn-sm" type="button" @click="custom=false">Cancel</button><button class="btn btn-primary btn-sm" type="submit">Apply period</button></div></form>
   </PopoverContent></PopoverPortal>
  </PopoverRoot>
  <button class="icon-button" aria-label="Next period" @click="store.shiftPeriod(1)"><ChevronRight :size="16"/></button>
  <button class="btn btn-sm period-today" @click="store.setDate(dateString(new Date()));store.setPeriodMode('day')">Today</button>
 </div>
</template>
<style scoped>
.workspace-period-picker{display:flex;align-items:center;flex-wrap:wrap;gap:6px;min-width:0;color:var(--text)}.workspace-period-picker select,.period-day{min-height:var(--control-height,36px);padding:6px 9px;border:1px solid var(--border);border-radius:var(--radius-inner);background:var(--surface);color:var(--text);font:inherit;font-size:var(--text-sm)}.workspace-period-picker select{width:100px;min-width:0}.period-day{width:145px}.period-label{padding:7px 8px;border-radius:var(--radius-inner);font-size:var(--text-sm);font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}.period-label:hover{background:var(--hover)}.period-label:focus-visible{outline:2px solid var(--accent)}.period-editor{z-index:100;width:290px;max-width:calc(100vw - 24px);padding:16px;border:1px solid var(--border);border-radius:var(--radius-card);background:var(--panel-raised);color:var(--text);box-shadow:0 8px 24px #0003}.period-editor form{display:grid;gap:12px}.period-editor strong{font-size:var(--text-sm)}.period-editor label{display:grid;gap:5px;font-size:var(--text-sm);color:var(--muted)}.period-editor input{width:100%;min-height:var(--control-height,36px);padding:7px 10px;border:1px solid var(--border);border-radius:var(--radius-inner);background:var(--surface);color:var(--text);font:inherit;box-sizing:border-box}.period-editor p{margin:0;font-size:var(--text-sm);color:var(--status-warning)}.period-editor-actions{display:flex;justify-content:flex-end;gap:8px}@media(max-width:500px){.period-label{font-size:var(--text-xs)}.workspace-period-picker{gap:3px}.workspace-period-picker select{width:85px}.period-today{padding-inline:8px}}
</style>
