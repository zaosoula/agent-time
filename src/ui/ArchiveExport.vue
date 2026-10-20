<script setup lang="ts">
import {ref} from 'vue';
import {archiveTransport} from './transport.ts';
const busy=ref(false),error=ref(''),result=ref<{path:string;bytes:number;events:number}|null>(null);
async function exportArchive(){busy.value=true;error.value='';try{result.value=await archiveTransport.export();}catch(cause){error.value=String(cause);}finally{busy.value=false;}}
</script>
<template>
<section class="archive-export">
 <h3>Local archive</h3><p>Create a verified SQLite copy of all captured events, review decisions, and manual notes. The archive stays on this Mac and does not remove history.</p>
 <button :disabled="busy" @click="exportArchive">{{busy?'Creating archive…':'Create archive'}}</button>
 <p v-if="error" class="archive-error" role="alert">{{error}}</p>
 <div v-if="result" role="status"><strong>{{result.events.toLocaleString()}} events · {{Math.round(result.bytes/1024/1024)}} MB</strong><code>{{result.path}}</code><small>Keep this file somewhere protected. It may include project paths and active website URLs.</small></div>
</section>
</template>
<style scoped>
.archive-export{margin-top:16px;padding:19px 20px;border:1px solid var(--border);border-radius:10px;background:var(--panel)}.archive-export h3{font-size:13px;margin:0 0 6px}.archive-export p,.archive-export small{font-size:11px;color:var(--muted);line-height:1.5}.archive-export button{margin-top:8px;padding:8px 10px;border-radius:6px;background:var(--hover);font-size:11px}.archive-export button:disabled{opacity:.5}.archive-export div{margin-top:12px;display:flex;flex-direction:column;gap:6px;font-size:11px}.archive-export code{overflow-wrap:anywhere}.archive-error{color:#d07878!important}
</style>
