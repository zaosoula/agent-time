<script setup lang="ts">
import {computed,onMounted,ref} from 'vue';
import {storageTransport,storageRecoveryTransport,type PendingStorage,type PreparedStorage,type StorageReplacementResult} from './transport.ts';
import type {StorageUsage} from '../capture/storage-usage.ts';
defineProps<{running:boolean}>();
const usage=ref<StorageUsage|null>(null),busy=ref(false),error=ref('');
const pending=ref<PendingStorage|null>(null),prepared=ref<PreparedStorage|null>(null);
const lastResult=ref<StorageReplacementResult|null>(null);
const size=(bytes:number)=>bytes<1024?`${bytes} B`:bytes<1024**2?`${(bytes/1024).toFixed(1)} KB`:bytes<1024**3?`${(bytes/1024**2).toFixed(1)} MB`:`${(bytes/1024**3).toFixed(2)} GB`;
const rows=computed(()=>usage.value?[
 {name:'Event database',value:usage.value.database},
 {name:'SQLite write-ahead log',value:usage.value.wal},
 {name:'SQLite shared memory',value:usage.value.sharedMemory},
 {name:'Pending hook events',value:usage.value.spool},
 {name:'Generated hook runtimes',value:usage.value.runtimes},
 {name:'Local archives',value:usage.value.exports},
]:[]);
const recent=computed(()=>{
 const days=new Map<string,{events:number;bytes:number}>();
 for(const row of usage.value?.byDay||[]){
  const day=days.get(row.date)||{events:0,bytes:0};day.events+=row.events;day.bytes+=row.payloadBytes;days.set(row.date,day);
 }
 return [...days].sort((a,b)=>b[0].localeCompare(a[0])).slice(0,7);
});
const forecast=computed(()=>{
 const days=recent.value.filter(([,day])=>day.events>0);
 return days.length?Math.round(days.reduce((total,[,day])=>total+day.bytes,0)/days.length*30):null;
});
async function refresh(){busy.value=true;error.value='';try{[usage.value,pending.value,lastResult.value]=await Promise.all([storageTransport.usage(),storageRecoveryTransport.pending(),storageRecoveryTransport.result()]);}catch(cause){error.value=String(cause);}finally{busy.value=false;}}
async function reclaim(){busy.value=true;error.value='';try{usage.value=await storageTransport.reclaim();}catch(cause){error.value=String(cause);}finally{busy.value=false;}}
async function compact(){busy.value=true;error.value='';try{prepared.value=await storageRecoveryTransport.prepare();pending.value=await storageRecoveryTransport.pending();usage.value=await storageTransport.usage();}catch(cause){error.value=String(cause);}finally{busy.value=false;}}
async function cancel(){busy.value=true;error.value='';try{await storageRecoveryTransport.cancel();pending.value=null;prepared.value=null;usage.value=await storageTransport.usage();}catch(cause){error.value=String(cause);}finally{busy.value=false;}}
onMounted(()=>{void refresh();});
</script>
<template>
<section class="storage-usage" aria-labelledby="storage-title">
 <div class="storage-head"><div><h3 id="storage-title">Storage</h3><p>See what Agent Time keeps on this Mac. Index space is part of the database size.</p></div><button :disabled="busy" @click="refresh">{{busy?'Measuring…':'Refresh'}}</button></div>
 <p v-if="error" role="alert" class="storage-error">{{error}}</p>
 <template v-if="usage">
  <strong class="storage-total">{{size(usage.totalBytes)}} total · {{usage.eventCount.toLocaleString()}} events</strong>
  <p v-if="usage.freeBytes!==null">{{size(usage.freeBytes)}} available on this disk.<span v-if="usage.freeBytes<usage.database.bytes+64*1024*1024" class="storage-error"> A verified compacted copy needs at least {{size(usage.database.bytes+64*1024*1024)}} free; clear space before preparing it.</span></p>
  <p v-if="lastResult" role="status">{{lastResult.status==='applied'?'Storage replacement completed. The prior database remains in Local archives as '+lastResult.backup+'. Review capture before choosing whether to delete it.':'Storage replacement was cancelled because data changed or the prior swap was interrupted. The current database was kept.'}}</p>
  <dl><div v-for="row in rows" :key="row.name"><dt>{{row.name}}</dt><dd>{{size(row.value.bytes)}}<small v-if="row.value.truncated"> · partial scan</small></dd></div></dl>
  <p>Database indexes occupy about {{size(usage.indexes.bytes)}} within the event database. Recent captured payload, excluding database and index overhead:</p>
  <ul><li v-for="[date,day] in recent" :key="date"><span>{{date}}</span><span>{{day.events.toLocaleString()}} events · {{size(day.bytes)}}</span></li></ul>
  <p v-if="!recent.length">No events recorded in the last 30 days.</p>
  <p v-if="forecast!==null">At the recent captured-payload rate, another 30 tracked days would add about {{size(forecast)}} before database and index overhead. This is an estimate, not a storage limit.</p>
  <div v-if="usage.wal.bytes>0" class="storage-action"><p>Reclaim the SQLite write-ahead log after saved events are checkpointed. This keeps all observations and review decisions.</p><button :disabled="busy" @click="reclaim">Reclaim {{size(usage.wal.bytes)}} of temporary space</button></div>
  <div class="storage-action"><p>Create a verified compacted copy. Agent Time compares event order, timing, coverage, and review decisions before replacing the database on the next launch. The original stays as a restorable archive, so total storage initially increases. Delete that archive explicitly only after confirming capture works.</p>
   <button v-if="!pending" :disabled="busy||running" @click="compact">{{busy?'Verifying copy…':'Prepare compacted database'}}</button>
   <small v-if="running">Pause capture before preparing space recovery.</small>
   <template v-if="pending"><strong>{{pending.kind==='compaction'?'Compacted database':'Archive replacement'}} ready for the next launch</strong><p v-if="prepared">Live database reduction: {{size(prepared.savingsBytes)}}. Events: {{prepared.beforeRows.toLocaleString()}} → {{prepared.afterRows.toLocaleString()}}. The rollback archive will also use disk space.</p><p>Quit Agent Time completely, then reopen it to apply. If the source changes first, replacement is cancelled and current data remains in place.</p><button :disabled="busy" @click="cancel">Cancel pending replacement</button></template>
  </div>
 </template>
</section>
</template>
<style scoped>
.storage-usage{margin-top:16px;padding:19px 20px;border:1px solid var(--border);border-radius:10px;background:var(--panel);font-size:11px}.storage-head{display:flex;align-items:start;justify-content:space-between;gap:16px}.storage-head h3{font-size:13px;margin:0 0 6px}.storage-usage p{color:var(--muted);line-height:1.5;margin:6px 0 12px}.storage-head button{background:var(--hover);border-radius:6px;padding:7px 10px;white-space:nowrap}.storage-head button:disabled{opacity:.5}.storage-total{display:block;font-size:13px;margin:12px 0}.storage-usage dl{margin:0}.storage-usage dl div,.storage-usage li{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-top:1px solid var(--border)}.storage-usage dd{margin:0;font-variant-numeric:tabular-nums}.storage-usage ul{padding:0;margin:0;list-style:none}.storage-error{color:#d07878!important}
.storage-action{border-top:1px solid var(--border);padding-top:10px}.storage-action button{padding:8px 10px;border-radius:6px;background:var(--blue);color:white}.storage-action button:disabled{opacity:.5}
</style>
