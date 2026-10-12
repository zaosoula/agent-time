<script setup lang="ts">
import {ref,onMounted,onUnmounted,computed} from 'vue';
import {DialogRoot,DialogPortal,DialogOverlay,DialogContent,DialogTitle,DialogDescription} from 'reka-ui';
import {Bot,Check,RefreshCw} from '@lucide/vue';
import {transport} from './transport.ts';
import type {HookInstallationStatus,HookProvider} from '../capture/hook-installation.ts';
const props=defineProps<{mode:'onboarding'|'settings'}>();
const state=ref<HookInstallationStatus|null>(null),open=ref(false),busy=ref(false),error=ref(''),message=ref('');
const selected=ref<HookProvider[]>(['claude','codex']);
let timer:ReturnType<typeof setInterval>|undefined,unmounted=false;
const providers:HookProvider[]=['claude','codex'];
const targets=(provider:HookProvider)=>state.value?.targets.filter(t=>t.provider===provider)||[];
const installed=(provider:HookProvider)=>targets(provider).length>0&&targets(provider).every(t=>t.state==='installed');
const hasFailures=computed(()=>state.value?.targets.some(t=>t.state==='error')||Boolean(state.value?.migrationError));
const received=(n:number|null)=>n?new Date(n*1000).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):'Waiting for an event';
const label=(s:string)=>({'not-installed':'Not installed',installed:'Installed','needs-update':'Update needed',error:'Needs attention'}[s]||s);
async function refresh(){if(busy.value)return;try{const next=await transport.hooksStatus();if(unmounted)return;state.value=next;if(props.mode==='onboarding'&&!next.setupSeen)open.value=true;}catch(e){error.value=String(e);}}
async function install(list:HookProvider[]){busy.value=true;error.value='';message.value='';try{for(const provider of list)state.value=await transport.installHooks(provider);message.value=hasFailures.value?'Some configurations need attention. Check the details below.':'Hooks installed. Start a new session to receive events.';}catch(e){error.value=String(e);}finally{busy.value=false;}}
async function verify(){busy.value=true;error.value='';try{state.value=await transport.verifyHooks();message.value='Installation checked.';}catch(e){error.value=String(e);}finally{busy.value=false;}}
async function dismiss(){if(busy.value)return;try{state.value=await transport.dismissHookSetup();open.value=false;}catch(e){error.value=String(e);}}
onMounted(()=>{void refresh();timer=setInterval(()=>{void refresh();},5000);});onUnmounted(()=>{unmounted=true;clearInterval(timer);});
</script>
<template>
<DialogRoot v-if="mode==='onboarding'" :open="open" @update:open="!$event&&dismiss()"><DialogPortal><DialogOverlay class="hook-overlay"/><DialogContent class="hook-dialog" @escape-key-down="busy&&$event.preventDefault()" @pointer-down-outside="busy&&$event.preventDefault()">
 <div class="hook-dialog-icon"><Bot :size="24"/></div><DialogTitle class="hook-title">Connect your agents</DialogTitle><DialogDescription class="hook-description">Install Agent Time hooks for your user account to capture sessions across projects.</DialogDescription>
 <div class="hook-choices"><label v-for="p in providers" :key="p"><input v-model="selected" type="checkbox" :value="p" :disabled="busy"/><span>{{p==='claude'?'Claude Code':'Codex'}}<small>{{targets(p).length}} user configuration{{targets(p).length===1?'':'s'}}{{installed(p)?' · installed':''}}</small></span><Check v-if="installed(p)" :size="16"/></label></div>
 <p class="hook-description">Detected Orca account homes are included. Existing hooks from other tools are preserved.</p>
 <p v-if="state?.legacyPaths.length" class="hook-description">Your earlier Agent Time project hooks will move to user scope.</p>
 <p class="hook-trust">After installation, start new agent sessions. In Codex, review and trust the “Agent Time” hooks in <strong>/hooks</strong>. Configuration checks cannot confirm provider trust.</p>
 <p v-if="error" class="hook-error" role="alert">{{error}}</p><p v-if="message" class="hook-message" role="status">{{message}}</p>
 <div v-if="hasFailures" class="hook-problems"><p v-for="t in state?.targets.filter(t=>t.error)" :key="t.id">{{t.label}}: {{t.error}}</p><p v-if="state?.migrationError">Project migration: {{state.migrationError}}</p></div>
 <div class="hook-dialog-actions"><button :disabled="busy" @click="dismiss">{{message?'Done':'Set up later'}}</button><button class="hook-primary" :disabled="busy||!selected.length||!state" @click="install(selected)">{{busy?'Installing…':'Install selected hooks'}}</button></div>
</DialogContent></DialogPortal></DialogRoot>
<section v-else class="hook-settings" aria-labelledby="hook-settings-heading">
 <div class="hook-section-heading"><div><h2 id="hook-settings-heading">Agent hook installation</h2><p>Connect Claude and Codex across all projects on this Mac.</p></div><button class="hook-check" :disabled="busy||!state" @click="verify"><RefreshCw :size="13"/> Check installation</button></div>
 <p v-if="error" class="hook-error" role="alert">{{error}}</p><p v-if="message" class="hook-message" role="status">{{message}}</p>
 <div v-for="p in providers" :key="p" class="hook-provider"><div class="hook-provider-heading"><strong>{{p==='claude'?'Claude Code':'Codex'}}</strong><button class="hook-action" :disabled="busy||!state" @click="install([p])">{{busy?'Working…':installed(p)?'Update hooks':'Install / repair hooks'}}</button></div>
  <div v-for="t in targets(p)" :key="t.id" class="hook-target"><div><span>{{t.label}}</span><small>{{received(t.lastEvent)}}</small></div><span :class="['hook-state',t.state]">{{label(t.state)}}</span><p v-if="t.error" class="hook-error">{{t.error}}</p></div>
  <details v-if="targets(p).length" class="hook-paths"><summary>Configuration locations</summary><code v-for="t in targets(p)" :key="t.id">{{t.path}}</code></details>
 </div>
 <p v-if="state?.migrationError" class="hook-error">Project migration needs attention: {{state.migrationError}}</p><p v-else-if="state?.legacyPaths.length" class="hook-description">Installing here also removes your earlier Agent Time project hooks.</p>
 <p class="hook-trust">Start new sessions after installation or updates. Codex requires review in <strong>/hooks</strong>. “Installed” means the configuration and runtime are present; received events confirm capture is reaching Agent Time.</p>
</section>
</template>
<style scoped>
.hook-overlay{position:fixed;inset:0;background:#0006;z-index:100;backdrop-filter:blur(3px)}.hook-dialog{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:min(500px,calc(100vw - 48px));max-height:85vh;overflow:auto;background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:14px;padding:28px;box-shadow:0 18px 65px #0005;z-index:101}.hook-dialog-icon{display:flex;align-items:center;justify-content:center;width:46px;height:46px;border-radius:12px;background:var(--hover);color:var(--blue);margin-bottom:18px}.hook-title{font-size:22px;font-weight:600;letter-spacing:-.5px;display:block;margin-bottom:10px}.hook-description,.hook-trust{font-size:12px;line-height:1.6;color:var(--muted);margin:8px 0 14px;display:block}.hook-choices{border:1px solid var(--border);border-radius:8px;margin:20px 0;overflow:hidden}.hook-choices label{display:flex;align-items:center;gap:12px;padding:15px;border-bottom:1px solid var(--border);font-size:13px}.hook-choices label:last-child{border:0}.hook-choices label>span{flex:1}.hook-choices small{display:block;color:var(--muted);font-size:11px;margin-top:4px}input{accent-color:var(--blue)}.hook-dialog-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:22px}.hook-dialog-actions button,.hook-check,.hook-action{font-size:12px;padding:8px 12px;border-radius:6px;background:var(--hover)}.hook-primary{background:var(--blue)!important;color:white}.hook-settings{margin-top:22px;border:1px solid var(--border);border-radius:10px;background:var(--panel);padding:20px}.hook-section-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:15px}.hook-section-heading h2{font-size:13px;margin:0 0 8px}.hook-section-heading p{font-size:12px;color:var(--muted);margin:0 0 10px}.hook-check{display:flex;align-items:center;gap:6px;white-space:nowrap}.hook-provider{padding-top:17px;margin-top:12px;border-top:1px solid var(--border)}.hook-provider-heading{display:flex;align-items:center;justify-content:space-between;font-size:13px;margin-bottom:12px}.hook-action{color:var(--blue)}.hook-target{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;padding:10px 0;font-size:12px}.hook-target small{display:block;font-size:10px;color:var(--muted);margin-top:4px}.hook-state{font-size:11px;color:var(--muted)}.hook-state.installed{color:#31a783}.hook-state.error,.hook-state.needs-update{color:#d49542}.hook-error{font-size:12px;line-height:1.5;color:#d07878;overflow-wrap:anywhere;width:100%}.hook-message{font-size:12px;color:var(--blue);line-height:1.5}.hook-problems{max-height:110px;overflow:auto;font-size:11px;color:#d07878}.hook-paths{font-size:11px;color:var(--muted);margin:8px 0}.hook-paths summary{cursor:pointer}.hook-paths code{display:block;margin-top:7px;overflow-wrap:anywhere;font-size:10px}.hook-trust{margin:18px 0 0}button:disabled{opacity:.5;cursor:default}button:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid var(--blue);outline-offset:3px}
</style>
