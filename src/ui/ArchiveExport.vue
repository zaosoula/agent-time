<script setup lang="ts">
import {onMounted,ref} from 'vue';
import {archiveTransport,native} from './transport.ts';
import type {ArchivePreview} from '../capture/store.ts';
defineProps<{running:boolean}>();
const busy=ref(false),error=ref(''),result=ref<{path:string;bytes:number;events:number}|null>(null);
const archives=ref<Array<{id:string;bytes:number}>>([]),selected=ref(''),preview=ref<ArchivePreview|null>(null),restored=ref('');
async function refresh(){archives.value=await archiveTransport.list();if(!archives.value.some(item=>item.id===selected.value))selected.value=archives.value[0]?.id||'';}
async function exportArchive(){busy.value=true;error.value='';try{result.value=await archiveTransport.export();await refresh();}catch(cause){error.value=String(cause);}finally{busy.value=false;}}
async function chooseArchive(){busy.value=true;error.value='';try{const id=await archiveTransport.choose();if(id){await refresh();selected.value=id;preview.value=null;await inspect();}}catch(cause){error.value=String(cause);}finally{busy.value=false;}}
async function inspect(){if(!selected.value)return;busy.value=true;error.value='';preview.value=null;restored.value='';try{preview.value=await archiveTransport.preview(selected.value);}catch(cause){error.value=String(cause);}finally{busy.value=false;}}
async function restore(){if(!preview.value||selected.value!==preview.value.id)return;busy.value=true;error.value='';try{const result=await archiveTransport.import(selected.value);restored.value=`Added ${result.addedEvents} events, ${result.addedNotes} notes and ${result.addedDecisions} review decisions.`;preview.value=null;}catch(cause){error.value=String(cause);}finally{busy.value=false;}}
onMounted(()=>{void refresh().catch(cause=>{error.value=String(cause);});});
</script>
<template>
<section class="archive-export">
 <h3>Local archive</h3><p>Create a verified SQLite copy of all captured events, review decisions, and manual notes. The archive stays on this Mac and does not remove history.</p>
 <button :disabled="busy" @click="exportArchive">{{busy?'Creating archive…':'Create archive'}}</button>
 <button v-if="native" :disabled="busy" @click="chooseArchive">Choose archive from Finder…</button>
 <p v-if="error" class="archive-error" role="alert">{{error}}</p>
 <div v-if="result" role="status"><strong>{{result.events.toLocaleString()}} events · {{Math.round(result.bytes/1024/1024)}} MB</strong><code>{{result.path}}</code><small>Keep this file somewhere protected. It may include project paths and active website URLs.</small></div>
 <div v-if="archives.length" class="archive-restore">
  <strong>Restore a local archive</strong><p>Preview an archive saved by this installation. Restoration only adds missing records; it stops if any evidence or review decision conflicts with current data.</p>
  <label>Archive <select v-model="selected" :disabled="busy" @change="preview=null"><option v-for="item in archives" :key="item.id" :value="item.id">{{item.id}} · {{Math.round(item.bytes/1024/1024)}} MB</option></select></label>
  <button :disabled="busy||!selected" @click="inspect">Preview restore</button>
  <p v-if="preview">Adds {{preview.newEvents}} events, {{preview.newNotes}} notes and {{preview.newDecisions}} review decisions. Conflicts: {{preview.eventConflicts+preview.noteConflicts+preview.decisionConflicts}}.</p>
  <button v-if="preview" :disabled="busy||running||Boolean(preview.eventConflicts+preview.noteConflicts+preview.decisionConflicts)" @click="restore">Restore missing records</button>
  <small v-if="running">Pause capture to restore an archive.</small><small v-if="restored" role="status">{{restored}}</small>
 </div>
</section>
</template>
<style scoped>
.archive-export{margin-top:16px;padding:19px 20px;border:1px solid var(--border);border-radius:10px;background:var(--panel)}.archive-export h3{font-size:13px;margin:0 0 6px}.archive-export p,.archive-export small{font-size:11px;color:var(--muted);line-height:1.5}.archive-export button{margin-top:8px;padding:8px 10px;border-radius:6px;background:var(--hover);font-size:11px}.archive-export button:disabled{opacity:.5}.archive-export div{margin-top:12px;display:flex;flex-direction:column;gap:6px;font-size:11px}.archive-export code{overflow-wrap:anywhere}.archive-error{color:#d07878!important}.archive-restore{padding-top:13px;border-top:1px solid var(--border)}.archive-restore label{display:flex;flex-direction:column;gap:5px}.archive-restore select{max-width:100%;padding:7px;background:var(--hover);color:var(--text);border:1px solid var(--border);border-radius:6px}
</style>
