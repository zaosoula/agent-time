<script setup lang="ts">
import {computed,ref,watch} from 'vue';
import type {Interval} from '../capture/events.ts';
import type {ManualNote} from '../capture/store.ts';
import {manualNoteTransport} from './transport.ts';
import {unobservedGaps} from '../capture/gaps.ts';
const props=defineProps<{date:string;intervals:Interval[]}>();
const open=ref(false),notes=ref<ManualNote[]>([]),from=ref(''),to=ref(''),project=ref(''),note=ref(''),error=ref(''),busy=ref(false);
let loadGeneration=0;
const gaps=computed(()=>unobservedGaps(props.intervals));
const time=(seconds:number)=>new Date(seconds*1000).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});
const minutes=(seconds:number)=>`${Math.round(seconds/60)}m`;
async function load(){const generation=++loadGeneration,date=props.date;if(!open.value)return;try{const next=await manualNoteTransport.list(date);if(generation===loadGeneration&&props.date===date&&open.value){notes.value=next;error.value='';}}catch(cause){if(generation===loadGeneration&&props.date===date)error.value=String(cause);}}
watch([open,()=>props.date],()=>{notes.value=[];from.value='';to.value='';void load();});
function useGap(start:number,end:number){from.value=new Date(start*1000).toTimeString().slice(0,5);to.value=new Date(end*1000).toTimeString().slice(0,5);}
async function add(){
 const date=props.date,start=new Date(`${date}T${from.value}:00`).getTime()/1000,end=new Date(`${date}T${to.value}:00`).getTime()/1000;
 if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start){error.value='Choose a valid start and end on this day.';return;}
 busy.value=true;error.value='';try{const saved=await manualNoteTransport.add({start,end,project:project.value,note:note.value});if(props.date===date){notes.value.push(saved);notes.value.sort((a,b)=>a.start-b.start);note.value='';}}catch(cause){if(props.date===date)error.value=String(cause);}finally{busy.value=false;}
}
async function remove(id:string){const date=props.date;busy.value=true;error.value='';try{await manualNoteTransport.remove(id);if(props.date===date)notes.value=notes.value.filter(item=>item.id!==id);}catch(cause){if(props.date===date)error.value=String(cause);}finally{busy.value=false;}}
</script>
<template>
<section class="manual-notes">
 <button class="manual-heading" :aria-expanded="open" @click="open=!open"><span><strong>Unobserved time &amp; notes</strong><small>{{gaps.length}} gaps between observations · {{notes.length}} notes</small></span><span>{{open?'Hide':'Review'}}</span></button>
 <div v-if="open" class="manual-body"><p>Gaps mean Agent Time has no observation for that period. They do not prove you were idle. Notes are user-entered and never added to observed Mac or agent totals.</p>
  <div v-if="gaps.length" class="gap-list"><button v-for="gap in gaps.slice(0,30)" :key="gap.start" @click="useGap(gap.start,gap.end)">{{time(gap.start)}}–{{time(gap.end)}} · {{minutes(gap.seconds)}} unobserved</button></div><p v-else>No five-minute gaps between this day's observations. Time before the first and after the last observation is unknown.</p>
  <div class="note-form"><label>Start <input v-model="from" type="time"/></label><label>End <input v-model="to" type="time"/></label><label>Project <input v-model="project" placeholder="Optional project label"/></label><label class="note-text">Note <textarea v-model="note" maxlength="500" placeholder="What should you remember about this time?"/></label><button :disabled="busy||!from||!to||!note.trim()" @click="add">Add manual note</button></div>
  <p v-if="error" class="manual-error" role="alert">{{error}}</p>
  <ul><li v-for="item in notes" :key="item.id"><div><strong>{{time(item.start)}}–{{time(item.end)}} · {{item.project||'No project'}}</strong><span>{{item.note}}</span><small>User-entered · not observed</small></div><button :disabled="busy" @click="remove(item.id)">Remove</button></li></ul>
 </div>
</section>
</template>
<style scoped>
.manual-notes{margin:16px 0;border:1px solid var(--border);border-radius:10px;background:var(--panel);overflow:hidden}.manual-heading{width:100%;display:flex;justify-content:space-between;align-items:center;text-align:left;padding:15px 17px}.manual-heading span:first-child{display:flex;align-items:center;gap:10px}.manual-heading strong{font-size:12px}.manual-heading small,.manual-heading span:last-child{font-size:10px;color:var(--muted)}.manual-body{border-top:1px solid var(--border);padding:15px 17px}.manual-body p,.manual-body small{font-size:11px;line-height:1.5;color:var(--muted)}.gap-list{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0}.gap-list button,.note-form button,.manual-notes li button{border:1px solid var(--border);border-radius:6px;padding:7px 9px;background:var(--hover);font-size:10px}.note-form{display:flex;align-items:end;gap:8px;flex-wrap:wrap;margin:14px 0}.note-form label{display:flex;flex-direction:column;gap:4px;color:var(--muted);font-size:10px}.note-form input,.note-form textarea{border:1px solid var(--border);border-radius:6px;padding:7px 9px;background:var(--hover);color:var(--text);font-size:11px}.note-text{flex:1 1 240px}.note-text textarea{min-height:42px}.note-form button:disabled{opacity:.5}.manual-error{color:#d07878!important}.manual-notes ul{list-style:none;margin:10px 0 0;padding:0}.manual-notes li{display:flex;align-items:start;justify-content:space-between;gap:12px;padding:9px 0;border-top:1px solid var(--border);font-size:11px}.manual-notes li div{display:flex;flex-direction:column;gap:4px;overflow-wrap:anywhere}
</style>
