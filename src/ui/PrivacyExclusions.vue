<script setup lang="ts">
import {onMounted,ref} from 'vue';
import {privacyTransport} from './transport.ts';
import type {PrivacyExclusion} from '../capture/privacy-exclusions.ts';
const entries=ref<PrivacyExclusion[]>([]),kind=ref<'app'|'site'>('app'),value=ref(''),busy=ref(false),error=ref(''),message=ref('');
onMounted(async()=>{try{entries.value=await privacyTransport.list();}catch(cause){error.value=String(cause);}});
async function save(next:PrivacyExclusion[]):Promise<boolean>{busy.value=true;error.value='';message.value='';try{entries.value=await privacyTransport.replace(next);message.value='Exclusions saved. Existing history remains unchanged.';return true;}catch(cause){error.value=String(cause);return false;}finally{busy.value=false;}}
async function add(){const item={kind:kind.value,value:value.value.trim()};if(await save([...entries.value,item]))value.value='';}
</script>
<template>
<section class="privacy-exclusions">
 <h3>Activity exclusions</h3><p>Agent Time does not store foreground samples while an excluded app or exact website hostname is active. When site exclusions are set and the current browser hostname is unavailable, Agent Time discards that browser sample too. Existing history is kept. Agent hooks remain independent.</p>
 <div class="privacy-entry"><select v-model="kind" aria-label="Exclusion type"><option value="app">App bundle ID</option><option value="site">Website hostname</option></select><input v-model="value" :placeholder="kind==='app'?'com.example.app':'example.com'" aria-label="App bundle ID or website hostname" @keydown.enter="add"/><button :disabled="busy||!value.trim()" @click="add">Add exclusion</button></div>
 <ul><li v-for="item in entries" :key="item.kind+item.value"><span>{{item.kind==='app'?'App':'Website'}} · {{item.value}}</span><button :disabled="busy" :aria-label="`Remove ${item.value}`" @click="save(entries.filter(other=>other!==item))">Remove</button></li></ul>
 <p v-if="error" class="privacy-error" role="alert">{{error}}</p><p v-if="message" role="status">{{message}}</p>
</section>
</template>
<style scoped>
.privacy-exclusions{margin-top:16px;padding:19px 20px;border:1px solid var(--border);border-radius:10px;background:var(--panel)}.privacy-exclusions h3{font-size:13px;margin:0 0 6px}.privacy-exclusions p{font-size:11px;color:var(--muted);line-height:1.5}.privacy-entry{display:flex;gap:8px;flex-wrap:wrap;margin-top:15px}.privacy-entry input{flex:1;min-width:180px}.privacy-entry select,.privacy-entry input{border:1px solid var(--border);border-radius:6px;background:var(--hover);color:var(--text);padding:7px 9px;font-size:11px}.privacy-entry button,.privacy-exclusions li button{padding:7px 9px;border-radius:6px;background:var(--hover);font-size:11px}.privacy-entry button:disabled{opacity:.5}.privacy-exclusions ul{list-style:none;margin:14px 0 0;padding:0}.privacy-exclusions li{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:7px 0;border-top:1px solid var(--border);font-size:11px}.privacy-exclusions li span{overflow-wrap:anywhere}.privacy-error{color:#d07878!important}
</style>
