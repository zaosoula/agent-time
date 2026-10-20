<script setup lang="ts">
import {computed,onMounted,ref,watch} from 'vue';
import {weeklyTransport} from './transport.ts';
import {reviewedCsv,type WeeklyReview} from '../capture/weekly.ts';
const props=defineProps<{date:string;revision:number}>();
const open=ref(false),review=ref<WeeklyReview|null>(null),error=ref(''),loading=ref(false);
const goals=ref<Record<string,number>>({}),remind=ref(false);
const goalKey='agent-time:weekly-reviewed-goals:v1',remindKey='agent-time:weekly-goal-reminders:v1';
onMounted(()=>{try{const saved:unknown=JSON.parse(localStorage.getItem(goalKey)||'{}');if(saved&&typeof saved==='object'&&!Array.isArray(saved))goals.value=Object.fromEntries(Object.entries(saved).filter((entry):entry is [string,number]=>entry[0].startsWith('/')&&typeof entry[1]==='number'&&Number.isFinite(entry[1])&&entry[1]>=0&&entry[1]<=168));remind.value=localStorage.getItem(remindKey)==='true';}catch{/* Keep goals optional when local storage is unavailable. */}});
function setGoal(path:string,event:Event){const hours=Number((event.target as HTMLInputElement).value);if(!Number.isFinite(hours)||hours<0||hours>168)return;goals.value={...goals.value,[path]:hours};try{localStorage.setItem(goalKey,JSON.stringify(goals.value));}catch{/* In-memory goal still works for this session. */}}
function setReminder(event:Event){remind.value=(event.target as HTMLInputElement).checked;try{localStorage.setItem(remindKey,String(remind.value));}catch{/* In-memory reminder still works for this session. */}}
let loadGeneration=0;
const monday=computed(()=>{const day=new Date(props.date+'T12:00:00');day.setDate(day.getDate()-(day.getDay()+6)%7);return `${day.getFullYear()}-${String(day.getMonth()+1).padStart(2,'0')}-${String(day.getDate()).padStart(2,'0')}`;});
const duration=(seconds:number)=>seconds>=3600?`${Math.round(seconds/360)/10}h`:`${Math.round(seconds/60)}m`;
const label=(path:string)=>path==='Unassigned'?path:path.split('/').filter(Boolean).at(-1)||path;
const trendMax=computed(()=>Math.max(60,...(review.value?.days.flatMap(day=>[day.humanSeconds,day.agentSeconds,day.elapsedSeconds])||[])));
const width=(seconds:number)=>`${Math.max(0,seconds/trendMax.value*100)}%`;
async function load(){const generation=++loadGeneration,startDate=monday.value,revision=props.revision;review.value=null;if(!open.value)return;loading.value=true;error.value='';try{const next=await weeklyTransport.review(startDate);if(generation===loadGeneration&&startDate===monday.value&&revision===props.revision)review.value=next;}catch(cause){if(generation===loadGeneration)error.value=String(cause);}finally{if(generation===loadGeneration)loading.value=false;}}
watch([open,monday,()=>props.revision],()=>{void load();});
function exportReviewed(){
 if(!review.value?.reviewedEntries.length)return;
 const blob=new Blob([reviewedCsv(review.value.reviewedEntries)],{type:'text/csv;charset=utf-8'});
 const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`agent-time-reviewed-${monday.value}.csv`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
</script>
<template>
<section class="weekly-review">
 <button class="weekly-heading" :aria-expanded="open" @click="open=!open"><span><strong>Weekly review</strong><small>{{monday}} · seven days</small></span><span>{{open?'Hide':'Review week'}}</span></button>
 <div v-if="open" class="weekly-body">
  <p>Human, agent, and elapsed activity are separate measures. Concurrent agent work can make summed agent time exceed elapsed time.</p>
  <p v-if="loading">Loading week…</p><p v-if="error" class="weekly-error" role="alert">{{error}}</p>
  <template v-if="review"><div class="weekly-totals"><span>Mac <strong>{{duration(review.totals.humanSeconds)}}</strong></span><span>Agent <strong>{{duration(review.totals.agentSeconds)}}</strong></span><span>Elapsed <strong>{{duration(review.totals.elapsedSeconds)}}</strong></span></div>
   <div class="weekly-trend" aria-label="Daily activity trend"><div v-for="day in review.days" :key="day.date" class="trend-day"><strong>{{day.date.slice(5)}}</strong><div class="trend-bars"><span class="mac" :style="{width:width(day.humanSeconds)}" :title="`Mac ${duration(day.humanSeconds)}`"></span><span class="agent" :style="{width:width(day.agentSeconds)}" :title="`Agent ${duration(day.agentSeconds)}`"></span><span class="elapsed" :style="{width:width(day.elapsedSeconds)}" :title="`Elapsed ${duration(day.elapsedSeconds)}`"></span></div><small>Mac {{duration(day.humanSeconds)}} · Agent {{duration(day.agentSeconds)}} · Elapsed {{duration(day.elapsedSeconds)}}</small></div></div>
   <table><thead><tr><th>Project</th><th>Mac</th><th>Agent</th><th>Elapsed</th><th>Reviewed</th><th>Reviewed goal</th></tr></thead><tbody><tr v-for="project in review.projects" :key="project.project"><td :title="project.project">{{label(project.project)}}</td><td>{{duration(project.humanSeconds)}}</td><td>{{duration(project.agentSeconds)}}</td><td>{{duration(project.elapsedSeconds)}}</td><td>{{duration(project.reviewedSeconds)}}</td><td><input class="goal-input" type="number" min="0" max="168" step="0.5" :value="goals[project.project]||0" :aria-label="`Weekly reviewed hours goal for ${label(project.project)}`" @change="setGoal(project.project,$event)"/> h <small v-if="goals[project.project]">{{Math.min(100,Math.round(project.reviewedSeconds/(goals[project.project]*3600)*100))}}%</small></td></tr><tr v-if="!review.projects.length"><td colspan="6">No recorded activity this week.</td></tr></tbody></table>
   <label class="goal-reminder"><input type="checkbox" :checked="remind" @change="setReminder"/> Remind me here when reviewed project time is below its weekly goal</label><p v-if="remind&&review.projects.some(project=>goals[project.project]>0&&project.reviewedSeconds<goals[project.project]*3600)" role="status">Reviewed time is below a weekly goal. Review activity before assigning more time; unreviewed capture does not count toward goals.</p>
   <button class="weekly-export" :disabled="!review.reviewedEntries.length" @click="exportReviewed">Export {{review.reviewedEntries.length}} reviewed entries</button><small>The CSV contains reviewed Mac intervals only. Raw observations are unchanged.</small>
  </template>
 </div>
</section>
</template>
<style scoped>
.weekly-review{margin:16px 0;border:1px solid var(--border);border-radius:10px;background:var(--panel);overflow:hidden}.weekly-heading{width:100%;display:flex;align-items:center;justify-content:space-between;padding:15px 17px;text-align:left}.weekly-heading span:first-child{display:flex;align-items:center;gap:10px}.weekly-heading strong{font-size:12px}.weekly-heading small,.weekly-heading span:last-child{font-size:10px;color:var(--muted)}.weekly-body{border-top:1px solid var(--border);padding:15px 17px}.weekly-body p,.weekly-body small{font-size:11px;line-height:1.5;color:var(--muted)}.weekly-error{color:#d07878!important}.weekly-totals{display:flex;gap:22px;flex-wrap:wrap;padding:12px 0;font-size:11px}.weekly-totals span{display:flex;gap:7px}.weekly-review table{width:100%;border-collapse:collapse;font-size:11px;text-align:left}.weekly-review th,.weekly-review td{padding:8px;border-bottom:1px solid var(--border)}.weekly-review td:first-child{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.weekly-export{padding:7px 9px;margin:14px 8px 0 0;background:var(--hover);border-radius:6px;font-size:11px}.weekly-export:disabled{opacity:.5}
.weekly-trend{display:grid;gap:6px;margin:10px 0 16px}.trend-day{display:grid;grid-template-columns:44px minmax(100px,1fr) auto;gap:8px;align-items:center;font-size:10px}.trend-day strong{font-size:10px}.trend-day small{white-space:nowrap}.trend-bars{display:grid;gap:2px}.trend-bars span{display:block;height:3px;min-width:0;border-radius:2px}.trend-bars .mac{background:#d49542}.trend-bars .agent{background:#7769d9}.trend-bars .elapsed{background:#31a783}@media(max-width:700px){.trend-day{grid-template-columns:44px 1fr}.trend-day small{grid-column:2}}
.goal-input{width:48px;border:1px solid var(--border);border-radius:4px;background:var(--hover);color:var(--text);padding:3px;font-size:10px}.goal-reminder{display:flex;align-items:center;gap:7px;margin:13px 0 0;font-size:10px;color:var(--muted)}
</style>
