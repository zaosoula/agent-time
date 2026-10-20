<script setup lang="ts">
import {computed,onMounted,ref} from 'vue';
import {storageTransport} from './transport.ts';
import type {StorageUsage} from '../capture/storage-usage.ts';
const usage=ref<StorageUsage|null>(null),busy=ref(false),error=ref('');
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
async function refresh(){busy.value=true;error.value='';try{usage.value=await storageTransport.usage();}catch(cause){error.value=String(cause);}finally{busy.value=false;}}
onMounted(()=>{void refresh();});
</script>
<template>
<section class="storage-usage" aria-labelledby="storage-title">
 <div class="storage-head"><div><h3 id="storage-title">Storage</h3><p>See what Agent Time keeps on this Mac. Index space is part of the database size.</p></div><button :disabled="busy" @click="refresh">{{busy?'Measuring…':'Refresh'}}</button></div>
 <p v-if="error" role="alert" class="storage-error">{{error}}</p>
 <template v-if="usage">
  <strong class="storage-total">{{size(usage.totalBytes)}} total · {{usage.eventCount.toLocaleString()}} events</strong>
  <dl><div v-for="row in rows" :key="row.name"><dt>{{row.name}}</dt><dd>{{size(row.value.bytes)}}<small v-if="row.value.truncated"> · partial scan</small></dd></div></dl>
  <p>Database indexes occupy about {{size(usage.indexes.bytes)}} within the event database. Recent captured payload, excluding database and index overhead:</p>
  <ul><li v-for="[date,day] in recent" :key="date"><span>{{date}}</span><span>{{day.events.toLocaleString()}} events · {{size(day.bytes)}}</span></li></ul>
  <p v-if="!recent.length">No events recorded in the last 30 days.</p>
 </template>
</section>
</template>
<style scoped>
.storage-usage{margin-top:16px;padding:19px 20px;border:1px solid var(--border);border-radius:10px;background:var(--panel);font-size:11px}.storage-head{display:flex;align-items:start;justify-content:space-between;gap:16px}.storage-head h3{font-size:13px;margin:0 0 6px}.storage-usage p{color:var(--muted);line-height:1.5;margin:6px 0 12px}.storage-head button{background:var(--hover);border-radius:6px;padding:7px 10px;white-space:nowrap}.storage-head button:disabled{opacity:.5}.storage-total{display:block;font-size:13px;margin:12px 0}.storage-usage dl{margin:0}.storage-usage dl div,.storage-usage li{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-top:1px solid var(--border)}.storage-usage dd{margin:0;font-variant-numeric:tabular-nums}.storage-usage ul{padding:0;margin:0;list-style:none}.storage-error{color:#d07878!important}
</style>
