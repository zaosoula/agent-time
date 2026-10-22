<script setup lang="ts">
import {ref,shallowRef,onMounted,onUnmounted} from 'vue';
import {listen,type UnlistenFn} from '@tauri-apps/api/event';
import {check,type Update,type DownloadEvent} from '@tauri-apps/plugin-updater';
import {relaunch} from '@tauri-apps/plugin-process';
import {invoke} from '@tauri-apps/api/core';
import {installBetaUpdate} from './beta-updates.ts';
const update=shallowRef<Update|null>(null),error=ref(''),busy=ref(false),progress=ref('');
let unlisten:UnlistenFn|undefined;
let unmounted=false;
let lastCheck=0;
async function checkNow(){
 if(busy.value)return;
 lastCheck=Date.now();
 busy.value=true;error.value='';
 try{const next=await check();await update.value?.close();update.value=next;}
 catch(e){error.value=`Could not check for updates: ${String(e)}`;}
 finally{busy.value=false;}
}
async function install(){
 const candidate=update.value;if(!candidate||busy.value)return;
 busy.value=true;error.value='';progress.value='Downloading update…';
 try{await installBetaUpdate(candidate,()=>invoke('prepare_update'),relaunch,(event)=>{
  const item=event as DownloadEvent;
  if(item.event==='Finished')progress.value='Installing and restarting…';
 },()=>invoke('resume_after_failed_update'));}
 catch(e){error.value=`Update failed: ${String(e)}`;progress.value='';busy.value=false;}
}
function checkOnReturn(){if(document.visibilityState==='visible'&&Date.now()-lastCheck>60_000)void checkNow();}
onMounted(()=>{void checkNow();void listen<string>('update-available',()=>{void checkNow();}).then(dispose=>{if(unmounted)dispose();else unlisten=dispose;});window.addEventListener('focus',checkOnReturn);document.addEventListener('visibilitychange',checkOnReturn);});
onUnmounted(()=>{unmounted=true;unlisten?.();window.removeEventListener('focus',checkOnReturn);document.removeEventListener('visibilitychange',checkOnReturn);if(!busy.value)void update.value?.close();});
</script>
<template>
<div v-if="update||error" class="beta-update" role="status">
 <template v-if="update"><strong>Agent Time {{update.version}} is available</strong><span>{{update.body||'A beta update is ready.'}}</span><button :disabled="busy" @click="install">{{busy?progress:'Install and restart'}}</button></template>
 <template v-else><button :disabled="busy" @click="checkNow">Retry update check</button></template>
 <span v-if="error" class="beta-update-error" role="alert">{{error}}</span>
</div>
</template>
<style scoped>
.beta-update{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:12px 20px;background:var(--panel);border-bottom:1px solid var(--border);font-size:12px}.beta-update span{flex:1;min-width:180px;color:var(--muted)}.beta-update button{padding:7px 10px;border-radius:6px;background:var(--blue);color:white}.beta-update button:disabled{opacity:.6}.beta-update-error{color:#d07878!important;flex-basis:100%}
</style>
