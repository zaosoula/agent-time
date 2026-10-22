<script setup lang="ts">
import {onMounted,ref} from 'vue';
import {archiveTransport,storageRecoveryTransport,native} from './transport.ts';
import type {ArchivePreview} from '../capture/store.ts';
defineProps<{running:boolean}>();
const busy=ref(false),error=ref(''),result=ref<{path:string;bytes:number;events:number}|null>(null),copied=ref(false);
const archives=ref<Array<{id:string;bytes:number}>>([]),selected=ref(''),preview=ref<ArchivePreview|null>(null),restored=ref(''),confirmDelete=ref(''),confirmReplace=ref('');
const conflictCount=()=>preview.value?preview.value.eventConflicts+preview.value.noteConflicts+preview.value.decisionConflicts+preview.value.splitConflicts+preview.value.reviewActionConflicts+preview.value.dayReviewConflicts+preview.value.usageConflicts:0;
async function refresh(){archives.value=await archiveTransport.list();if(!archives.value.some(item=>item.id===selected.value))selected.value=archives.value[0]?.id||'';}
async function exportArchive(){busy.value=true;error.value='';copied.value=false;try{result.value=await archiveTransport.export();await refresh();}catch(cause){error.value=String(cause);}finally{busy.value=false;}}
async function copyPath(){if(!result.value)return;try{await navigator.clipboard.writeText(result.value.path);copied.value=true;}catch(cause){error.value=`Could not copy the archive path: ${String(cause)}`;}}
async function chooseArchive(){busy.value=true;error.value='';try{const id=await archiveTransport.choose();if(id){await refresh();selected.value=id;preview.value=null;await inspect();}}catch(cause){error.value=String(cause);}finally{busy.value=false;}}
async function inspect(){if(!selected.value)return;busy.value=true;error.value='';preview.value=null;restored.value='';try{preview.value=await archiveTransport.preview(selected.value);}catch(cause){error.value=String(cause);}finally{busy.value=false;}}
async function restore(){if(!preview.value||selected.value!==preview.value.id||conflictCount())return;busy.value=true;error.value='';try{const result=await archiveTransport.import(selected.value);restored.value=`Restore complete: added ${result.addedEvents} events, ${result.addedNotes} notes and ${result.addedDecisions} review decisions. Open My day and Capture health to verify your history and a fresh observation.`;preview.value=null;}catch(cause){error.value=String(cause);}finally{busy.value=false;}}
async function replaceFromArchive(){if(!preview.value||selected.value!==preview.value.id)return;if(confirmReplace.value!==selected.value){confirmReplace.value=selected.value;return;}busy.value=true;error.value='';try{await storageRecoveryTransport.prepareRestore(selected.value);restored.value='Exact archive replacement is ready. Quit Agent Time completely, then reopen it. The current database will be kept as a local archive.';confirmReplace.value='';}catch(cause){error.value=String(cause);}finally{busy.value=false;}}
async function removeArchive(){if(confirmDelete.value!==selected.value){confirmDelete.value=selected.value;return;}busy.value=true;error.value='';try{const id=selected.value;await archiveTransport.remove(id);if(result.value?.path.endsWith('/'+id))result.value=null;confirmDelete.value='';preview.value=null;await refresh();}catch(cause){error.value=String(cause);}finally{busy.value=false;}}
onMounted(()=>{void refresh().catch(cause=>{error.value=String(cause);});});
</script>
<template>
<section class="archive-export">
 <h3>Back up and recover your history</h3><p>Create a verified local copy of captured events, review decisions, splits, day reviews, and notes. The live history stays in place.</p>
 <ol class="recovery-steps"><li><strong>Create an archive.</strong> Wait for its event count and file path below.</li><li><strong>Keep a second copy.</strong> Copy the archive to a protected external drive or another private location. It may contain project paths and website URLs.</li><li><strong>Recover when needed.</strong> Choose that file, preview the records, then restore missing data or prepare an exact replacement.</li><li><strong>Verify after recovery.</strong> Check My day for history and Capture health for a fresh observation.</li></ol>
 <button :disabled="busy" @click="exportArchive">{{busy?'Creating archive…':'Create archive'}}</button>
 <button v-if="native" :disabled="busy" @click="chooseArchive">Choose archive from Finder…</button>
 <p v-if="error" class="archive-error" role="alert">{{error}}</p>
 <div v-if="result" role="status"><strong>Archive verified · {{result.events.toLocaleString()}} events · {{Math.round(result.bytes/1024/1024)}} MB</strong><code>{{result.path}}</code><button @click="copyPath">{{copied?'Path copied':'Copy archive path'}}</button><small>In Finder, press ⇧⌘G and paste the path to find the file. Copy it to your protected backup location.</small></div>
 <div v-if="archives.length" class="archive-restore">
  <strong>Restore a local archive</strong><p>Preview an archive saved by this installation. Restoration only adds missing records; it stops if any evidence or review decision conflicts with current data.</p>
  <label>Archive <select v-model="selected" :disabled="busy" @change="preview=null;confirmDelete='';confirmReplace=''"><option v-for="item in archives" :key="item.id" :value="item.id">{{item.id}} · {{Math.round(item.bytes/1024/1024)}} MB</option></select></label>
  <button :disabled="busy||!selected" @click="inspect">Preview restore</button>
  <p v-if="preview">Archive: {{preview.archiveEvents}} events. Adds {{preview.newEvents}} events, {{preview.newNotes}} notes, {{preview.newDecisions}} decisions, {{preview.newSplits}} splits, {{preview.newReviewActions}} history actions, {{preview.newDayReviews}} day reviews and {{preview.newUsageEvents}} usage records. Conflicts: {{conflictCount()}}.</p>
  <small v-if="preview&&conflictCount()" role="alert">The archive disagrees with current data. Missing-record restore is blocked; inspect the selected file before considering exact replacement.</small>
  <button v-if="preview" :disabled="busy||running||Boolean(conflictCount())" @click="restore">Restore missing records</button>
  <button v-if="preview" :disabled="busy||running" @click="replaceFromArchive">{{confirmReplace===selected?'Confirm exact replacement on next launch':'Replace all current data from archive…'}}</button>
  <small v-if="confirmReplace===selected" role="alert">The selected archive will replace the complete current database after you quit and reopen Agent Time. The current database becomes a local recovery archive.</small>
  <small v-if="running">Pause capture to restore an archive.</small><small v-if="restored" role="status">{{restored}}</small>
  <div class="archive-cleanup"><button :disabled="busy||!selected" @click="removeArchive">{{confirmDelete===selected?'Confirm permanent archive deletion':'Delete selected archive…'}}</button><small v-if="confirmDelete===selected" role="alert">This permanently removes this local archive. The live database is kept. Keep another protected backup before confirming.</small></div>
 </div>
</section>
</template>
<style scoped>
.archive-export{margin-top:16px;padding:19px 20px;border:1px solid var(--border);border-radius:10px;background:var(--panel)}.archive-export h3{font-size:13px;margin:0 0 6px}.archive-export p,.archive-export small{font-size:11px;color:var(--muted);line-height:1.5}.archive-export button{margin-top:8px;padding:8px 10px;border-radius:6px;background:var(--hover);font-size:11px}.archive-export button:disabled{opacity:.5}.archive-export div{margin-top:12px;display:flex;flex-direction:column;gap:6px;font-size:11px}.archive-export code{overflow-wrap:anywhere}.archive-error{color:#d07878!important}.archive-restore{padding-top:13px;border-top:1px solid var(--border)}.archive-restore label{display:flex;flex-direction:column;gap:5px}.archive-restore select{max-width:100%;padding:7px;background:var(--hover);color:var(--text);border:1px solid var(--border);border-radius:6px}.recovery-steps{margin:12px 0;padding-left:20px;color:var(--muted);font-size:11px;line-height:1.5}.recovery-steps li+li{margin-top:4px}.recovery-steps strong{color:var(--text)}
</style>
