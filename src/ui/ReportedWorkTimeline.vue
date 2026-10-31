<script setup lang="ts">
import {computed,ref} from 'vue';
import {Flag,Timer} from '@lucide/vue';
import type {ReportedWorkItem} from '../capture/reported-work.ts';
import type {TimeRange} from './timeline-viewport.ts';

const props=defineProps<{items:ReportedWorkItem[];range:TimeRange;now:number}>();
const expanded=ref(false);
const visible=computed(()=>props.items.filter(item=>item.kind==='context'?item.start>=props.range.start&&item.start<=props.range.end:item.end>=props.range.start&&item.start<=props.range.end));
const shown=computed(()=>expanded.value?visible.value:visible.value.slice(0,6));
const clock=(time:number)=>new Date(time*1000).toLocaleTimeString('en',{hour:'2-digit',minute:'2-digit',hour12:false});
const elapsed=(seconds:number)=>{const total=Math.max(0,Math.floor(seconds));return total>=3600?`${Math.floor(total/3600)}h ${String(Math.floor(total%3600/60)).padStart(2,'0')}m`:`${Math.floor(total/60)}m ${String(total%60).padStart(2,'0')}s`;};
function placement(item:ReportedWorkItem){
 const span=props.range.end-props.range.start;
 const from=Math.max(item.start,props.range.start),to=Math.min(item.end,props.range.end);
 return {left:`${Math.max(0,(from-props.range.start)/span*100)}%`,width:item.kind==='context'?'3px':`${Math.max(.3,(to-from)/span*100)}%`};
}
</script>
<template>
<section v-if="visible.length" class="reported-work" aria-label="Agent reported work on timeline">
 <div class="reported-heading"><strong>Agent reported work</strong><small>Task context and elapsed counters · excluded from tracked totals</small></div>
 <div v-for="item in shown" :key="item.id" class="reported-row">
  <div class="reported-label"><Timer v-if="item.kind==='counter'" :size="14"/><Flag v-else :size="14"/><span><strong :title="item.title">{{item.title}}</strong><small>{{item.issueKey ? item.issueKey+' · ' : ''}}{{item.provider||'Agent'}}{{item.sessionId?' · session '+item.sessionId.slice(-6):''}}</small></span></div>
  <div class="reported-track"><span class="reported-mark" :class="item.kind" :style="placement(item)" :title="item.kind==='context'?`${clock(item.start)} · reported context`:`${clock(item.start)}–${clock(item.end)} · reported counter`"></span></div>
  <span class="reported-value">{{item.kind==='context'?clock(item.start):elapsed((item.active?now:item.end)-item.start)}}<small v-if="item.active">open counter</small></span>
 </div>
 <button v-if="visible.length>6" class="reported-more" @click="expanded=!expanded">{{expanded?'Show fewer':`Show ${visible.length-6} more reported items`}}</button>
</section>
</template>
<style scoped>
.reported-work{border-bottom:1px solid var(--border);background:var(--panel)}
.reported-heading{display:flex;align-items:center;gap:10px;padding:9px 15px;border-bottom:1px solid var(--border)}
.reported-heading strong{font-size:11px}.reported-heading small{font-size:10px;color:var(--muted)}
.reported-row{display:grid;grid-template-columns:240px minmax(80px,1fr) 98px;align-items:center;gap:0;min-height:42px;padding:0 15px;border-bottom:1px solid var(--border)}
.reported-label{display:flex;align-items:center;gap:8px;min-width:0;color:var(--blue)}.reported-label span{min-width:0}.reported-label strong,.reported-label small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.reported-label strong{font-size:11px;color:var(--text)}.reported-label small{font-size:9px;color:var(--muted);margin-top:2px}
.reported-track{position:relative;height:22px;border-bottom:1px dashed var(--border)}.reported-mark{position:absolute;top:6px;height:9px;background:var(--blue);border-radius:4px;min-width:3px}.reported-mark.context{height:14px;top:3px;border-radius:2px;background:#31a783}
.reported-value{text-align:right;font-size:10px;font-variant-numeric:tabular-nums;color:var(--text)}.reported-value small{display:block;font-size:9px;color:var(--muted)}
.reported-more{display:block;padding:8px 15px;color:var(--blue);font-size:10px}
@media(max-width:1120px){.reported-row{grid-template-columns:190px minmax(80px,1fr) 82px}}
</style>
