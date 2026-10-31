<script setup lang="ts">
import {ref,watch,onMounted,onUnmounted,computed} from 'vue';
import {DialogRoot,DialogPortal,DialogOverlay,DialogContent,DialogTitle,DialogDescription} from 'reka-ui';
import {Bot,Check,RefreshCw,ShieldCheck,ArrowUpRight} from '@lucide/vue';
import {transport,mcpTransport,relaunchHookSetup,native,openAccessibilitySettings} from './transport.ts';
import type {HookInstallationStatus,HookProvider} from '../capture/hook-installation.ts';
import type {McpInstallationStatus} from '../capture/mcp-installation.ts';
const props=defineProps<{mode:'onboarding'|'settings'}>();
const emit=defineEmits<{status:[value:HookInstallationStatus]}>();
const state=ref<HookInstallationStatus|null>(null),open=ref(false),busy=ref(false),error=ref(''),message=ref('');
const mcpState=ref<McpInstallationStatus|null>(null),mcpSelected=ref(false),mcpError=ref(''),mcpMessage=ref('');
const permissionOpen=ref(false),permissionError=ref('');
const permissionSeenKey='agent-time.accessibility-setup-seen';
let permissionChecking=false;
watch(state,value=>{if(value)emit('status',value);});
const selected=ref<HookProvider[]>([]);
let timer:ReturnType<typeof setInterval>|undefined,unmounted=false,promptedIssueKey:string|null=null;
const providers=computed(()=>state.value?.agents.map(agent=>agent.id)||[]);
const agentName=(id:string)=>state.value?.agents.find(agent=>agent.id===id)?.name||id;
const targets=(provider:HookProvider)=>state.value?.targets.filter(t=>t.provider===provider)||[];
const installed=(provider:HookProvider)=>targets(provider).length>0&&targets(provider).every(t=>t.state==='installed');
const lastHookEvent=(provider:HookProvider)=>Math.max(0,...targets(provider).map(target=>target.lastEvent||0));
const hasFailures=computed(()=>state.value?.targets.some(t=>t.state==='error')||Boolean(state.value?.migrationError));
const repairTargets=computed(()=>state.value?.targets.filter(t=>t.state==='needs-update'||t.state==='error')||[]);
const repairing=computed(()=>Boolean(state.value?.setupSeen&&repairTargets.value.length));
const allInstalled=computed(()=>Boolean(state.value&&providers.value.length&&providers.value.every(installed)&&!hasFailures.value));
const received=(n:number|null)=>n?new Date(n*1000).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):'Waiting for an event';
const label=(s:string)=>({'not-installed':'Not installed',installed:'Installed','needs-update':'Update needed',error:'Needs attention'}[s]||s);
async function showPermission(){
 if(props.mode!=='onboarding'||!native||open.value||permissionOpen.value||permissionChecking||localStorage.getItem(permissionSeenKey)==='1')return;
 permissionChecking=true;
 try{const capture=await transport.status();if(capture.macos?.accessibilityTrusted===true){localStorage.setItem(permissionSeenKey,'1');return;}}catch{}
 finally{permissionChecking=false;}
 if(!unmounted&&!open.value&&localStorage.getItem(permissionSeenKey)!=='1')permissionOpen.value=true;
}
function dismissPermission(){localStorage.setItem(permissionSeenKey,'1');permissionOpen.value=false;}
async function openPermission(){permissionError.value='';try{await openAccessibilitySettings();dismissPermission();}catch(e){permissionError.value=String(e);}}
async function refresh(){if(busy.value)return;try{const next=await transport.hooksStatus();if(unmounted)return;state.value=next;if(!next.setupSeen&&!selected.value.length)selected.value=next.agents.map(agent=>agent.id);if(props.mode==='onboarding'){
  if(!next.setupSeen)open.value=true;
  else {const issues=next.targets.filter(t=>t.state==='needs-update'||t.state==='error');const key=issues.map(t=>`${t.id}:${t.state}`).sort().join('|')+(next.migrationError?`|migration:${next.migrationError}`:'');
    if(key&&message.value==='Hooks installed. Start a new session to receive events.')message.value='';
    if(!key)promptedIssueKey=null;
    else if(key!==promptedIssueKey){message.value='';selected.value=[...new Set(issues.map(t=>t.provider))];promptedIssueKey=key;permissionOpen.value=false;open.value=true;}
  }
  if(!open.value)void showPermission();
}}catch(e){error.value=String(e);}}
async function install(list:HookProvider[]){busy.value=true;error.value='';message.value='';mcpError.value='';try{for(const provider of list)state.value=await transport.installHooks(provider);message.value=list.some(p=>!installed(p))||state.value?.migrationError?'Some configurations need attention. Check the details below.':'Hooks installed. Start a new session to receive events.';if(mcpSelected.value){for(const provider of list.filter((p):p is 'claude'|'codex'=>p==='claude'||p==='codex')){try{mcpState.value=await mcpTransport.install(provider);}catch(e){mcpError.value+=`${agentName(provider)} MCP: ${String(e)}\n`;}}if(!mcpError.value)mcpMessage.value='MCP tools configured. Start a new agent session to load them.';}}catch(e){error.value=String(e);}finally{busy.value=false;if(mcpSelected.value)void refreshMcp();}}
async function refreshMcp(){try{mcpState.value=await mcpTransport.status();}catch(e){mcpError.value=String(e);}}
async function changeMcp(provider:'claude'|'codex',targetId:string,action:'install'|'remove'){busy.value=true;mcpError.value='';mcpMessage.value='';try{mcpState.value=action==='install'?await mcpTransport.install(provider,[targetId]):await mcpTransport.remove(provider,[targetId]);mcpMessage.value=action==='install'?'MCP configured. Start a new agent session to load the tools.':'MCP configuration removed. Restart the agent session to unload the tools.';}catch(e){mcpError.value=String(e);}finally{busy.value=false;void refreshMcp();}}
async function repairTarget(provider:HookProvider,id:string){busy.value=true;error.value='';message.value='';try{state.value=await transport.installHooks(provider,[id]);message.value='Hook configuration checked. Start a new session to verify delivery.';}catch(e){error.value=String(e);}finally{busy.value=false;}}
async function verify(){busy.value=true;error.value='';try{state.value=await transport.verifyHooks();message.value='Installation checked.';}catch(e){error.value=String(e);}finally{busy.value=false;}}
async function dismiss(){if(busy.value)return;try{state.value=await transport.dismissHookSetup();open.value=false;void showPermission();}catch(e){error.value=String(e);}}
function reopen(){if(props.mode!=='onboarding')return;error.value='';message.value='';permissionOpen.value=false;open.value=true;void refresh();}
onMounted(()=>{window.addEventListener('agent-time:hook-setup',reopen);void refresh();void refreshMcp();timer=setInterval(()=>{void refresh();},5000);});onUnmounted(()=>{unmounted=true;clearInterval(timer);window.removeEventListener('agent-time:hook-setup',reopen);});
</script>
<template>
<template v-if="mode==='onboarding'"><DialogRoot :open="open" @update:open="!$event&&dismiss()"><DialogPortal><DialogOverlay class="hook-overlay"/><DialogContent class="hook-dialog" @escape-key-down="busy&&$event.preventDefault()" @pointer-down-outside="busy&&$event.preventDefault()">
 <div class="hook-dialog-icon"><Bot :size="24"/></div><DialogTitle class="hook-title">{{repairing?'Update your agent hooks':'Connect your agents'}}</DialogTitle><DialogDescription class="hook-description">{{repairing?'Agent Time found hooks that need repair. Select the affected agents to update their user-wide installation.':'Install Agent Time hooks for your user account to capture sessions across projects.'}}</DialogDescription>
 <div class="hook-choices"><label v-for="p in providers" :key="p"><input v-model="selected" type="checkbox" :value="p" :disabled="busy"/><span>{{agentName(p)}}<small>{{targets(p).length}} user configuration{{targets(p).length===1?'':'s'}}{{installed(p)?' · installed':''}}</small><small v-if="installed(p)">{{lastHookEvent(p)?`Current runtime delivered an event ${received(lastHookEvent(p))}`:'Waiting for first event from the current runtime'}}</small></span><Check v-if="installed(p)" :size="16"/></label></div>
 <label v-if="!allInstalled" class="mcp-choice"><input v-model="mcpSelected" type="checkbox" :disabled="busy"/><span>Also connect local MCP tools<small>Selected agents can report current tasks and query tracked time. This changes their user MCP configuration.</small></span></label>
 <p class="hook-description">Detected Orca account homes are included. Existing hooks from other tools are preserved. Session IDs, project paths, event names and tool names are stored locally; prompt and tool output bodies are not collected by these hooks.</p>
 <p v-if="state?.legacyPaths.length" class="hook-description">Your earlier Agent Time project hooks will move to user scope.</p>
 <p class="hook-trust">After installation, start new agent sessions. In Codex, review and trust the “Agent Time” hooks in <strong>/hooks</strong>. Configuration checks cannot confirm provider trust.</p>
 <p v-if="error||mcpError" class="hook-error" role="alert">{{error||mcpError}}</p><p v-if="message||mcpMessage" class="hook-message" role="status">{{message}} {{mcpMessage}}</p>
 <div v-if="repairing||hasFailures" class="hook-problems"><p v-for="t in repairTargets" :key="t.id">{{t.label}}: {{t.error||label(t.state)}}</p><p v-if="state?.migrationError">Project migration: {{state.migrationError}}</p></div>
 <div class="hook-dialog-actions"><button :disabled="busy" @click="dismiss">{{allInstalled||message?'Done':repairing?'Later':'Set up later'}}</button><button v-if="!allInstalled" class="hook-primary" :disabled="busy||!selected.length||!state" @click="install(selected)">{{busy?'Installing…':repairing?'Update selected hooks':'Install selected hooks'}}</button></div>
</DialogContent></DialogPortal></DialogRoot>
<DialogRoot :open="permissionOpen" @update:open="!$event&&dismissPermission()"><DialogPortal><DialogOverlay class="hook-overlay"/><DialogContent class="hook-dialog">
 <div class="hook-dialog-icon"><ShieldCheck :size="24"/></div><DialogTitle class="hook-title">Connect Mac activity</DialogTitle><DialogDescription class="hook-description">Accessibility lets Agent Time identify the selected Orca tab and active website while you work.</DialogDescription>
 <p class="hook-description">Foreground app and idle tracking work without this permission. If you choose to grant it, macOS will open System Settings → Privacy &amp; Security → Accessibility. Return to Agent Time after enabling access.</p>
 <p v-if="permissionError" class="hook-error" role="alert">{{permissionError}}</p>
 <div class="hook-dialog-actions"><button @click="dismissPermission">Maybe later</button><button class="hook-primary" @click="openPermission">Open System Settings <ArrowUpRight :size="13"/></button></div>
</DialogContent></DialogPortal></DialogRoot></template>
<template v-else>
<section id="settings-agents" class="hook-section" aria-labelledby="agents-heading" tabindex="-1">
 <h2 id="agents-heading" class="section-title">Agents</h2><p class="section-intro">Global overview and actions for every connected agent.</p>
 <slot name="global-controls"/>
 <div class="hook-settings"><div class="hook-section-heading"><div><h3>Hook overview</h3><p>User-wide installation across all projects.</p></div></div>
  <div class="hook-overview"><div v-for="p in providers" :key="p"><strong>{{agentName(p)}}</strong><span v-if="state">{{targets(p).filter(t=>t.state==='installed').length}} of {{targets(p).length}} configurations installed</span><span v-else>Checking installation…</span></div></div>
  <div class="hook-global-actions"><button class="hook-check" :disabled="busy" @click="relaunchHookSetup">Relaunch hook setup</button><button class="hook-check" :disabled="busy||!state" @click="verify"><RefreshCw :size="13"/> Check all hooks</button><button class="hook-action" :disabled="busy||!state" @click="install(providers)">{{busy?'Working…':'Install / update all hooks'}}</button></div>
  <p v-if="error" class="hook-error" role="alert">{{error}}</p><p v-if="message" class="hook-message" role="status">{{message}}</p>
  <p v-if="state?.migrationError" class="hook-error">Project migration needs attention: {{state.migrationError}}</p><p v-else-if="state?.legacyPaths.length" class="hook-description">Installing here also moves your earlier Agent Time project hooks to user scope.</p>
 </div>
</section>
<section v-for="p in providers" :id="'settings-'+p" :key="p" class="hook-section" :aria-labelledby="p+'-heading'" tabindex="-1">
 <h2 :id="p+'-heading'" class="section-title">{{agentName(p)}}</h2><p class="section-intro">Hooks, tokens and usage settings for {{agentName(p)}}.</p>
 <slot :name="p+'-controls'"/>
 <div class="hook-settings"><div class="hook-provider-heading"><h3>Hook installation</h3><div class="hook-provider-actions"><button class="hook-check" :disabled="busy||!state" @click="verify"><RefreshCw :size="13"/> Check</button><button class="hook-action" :disabled="busy||!state" @click="install([p])">{{busy?'Working…':installed(p)?'Update hooks':'Install / repair hooks'}}</button></div></div>
  <div v-for="t in targets(p)" :key="t.id" class="hook-target"><div><span>{{t.label}}</span><small>{{received(t.lastEvent)}}</small></div><span :class="['hook-state',t.state]">{{label(t.state)}}</span><p v-if="t.reason" class="hook-reason">{{t.reason}}</p><p v-if="t.error" class="hook-error">{{t.error}}</p><button v-if="t.state!=='installed'" class="hook-check" :disabled="busy" @click="repairTarget(p,t.id)">Repair this configuration</button></div>
  <details v-if="targets(p).length" class="hook-paths"><summary>Configuration locations</summary><code v-for="t in targets(p)" :key="t.id">{{t.path}}</code></details>
  <p class="hook-trust">{{state?.agents.find(agent=>agent.id===p)?.trustNote||`Start a new ${agentName(p)} session after installing or updating hooks.`}}</p>
  <p class="hook-description">Installed confirms configuration and runtime files. A received event confirms capture is reaching Agent Time.</p>
 </div>
 <div v-if="p==='claude'||p==='codex'" class="hook-settings"><div class="hook-provider-heading"><h3>Local MCP tools</h3><button class="hook-check" :disabled="busy" @click="refreshMcp"><RefreshCw :size="13"/> Check</button></div>
  <p class="hook-description">Let this agent report its current task and query your local tracked time. Agent Time changes only its own user MCP entry.</p>
  <div v-for="t in mcpState?.targets.filter(target=>target.provider===p)||[]" :key="t.id" class="hook-target"><div><span>{{t.label}}</span><small>{{t.detail}}</small></div><span :class="['hook-state',t.state]">{{label(t.state)}}</span><button v-if="t.state==='not-installed'||t.state==='needs-update'" class="hook-action" :disabled="busy" @click="changeMcp(p,t.id,'install')">{{t.state==='needs-update'?'Repair':'Connect'}}</button><button v-if="t.state==='installed'" class="hook-check" :disabled="busy" @click="changeMcp(p,t.id,'remove')">Remove</button></div>
  <p v-if="!mcpState" class="hook-description">Checking MCP configuration…</p><p v-if="mcpError" class="hook-error" role="alert">{{mcpError}}</p><p v-if="mcpMessage" class="hook-message" role="status">{{mcpMessage}}</p>
  <p class="hook-description">A new agent session loads the tools. Tool descriptions are available automatically; ask the agent to report the current task when you want live context.</p>
 </div>
</section>
</template>
</template>
<style scoped>
.hook-overlay{position:fixed;inset:0;background:#0006;z-index:100;backdrop-filter:blur(3px)}.hook-dialog{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);width:min(500px,calc(100vw - 48px));max-height:85vh;overflow:auto;background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:14px;padding:28px;box-shadow:0 18px 65px #0005;z-index:101}.hook-dialog-icon{display:flex;align-items:center;justify-content:center;width:46px;height:46px;border-radius:12px;background:var(--hover);color:var(--blue);margin-bottom:18px}.hook-title{font-size:22px;font-weight:600;letter-spacing:-.5px;display:block;margin-bottom:10px}.hook-description,.hook-trust{font-size:12px;line-height:1.6;color:var(--muted);margin:8px 0 14px;display:block}.hook-choices{border:1px solid var(--border);border-radius:8px;margin:20px 0;overflow:hidden}.hook-choices label{display:flex;align-items:center;gap:12px;padding:15px;border-bottom:1px solid var(--border);font-size:13px}.hook-choices label:last-child{border:0}.hook-choices label>span{flex:1}.hook-choices small{display:block;color:var(--muted);font-size:11px;margin-top:4px}input{accent-color:var(--blue)}.hook-dialog-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:22px}.hook-dialog-actions button,.hook-check,.hook-action{font-size:12px;padding:8px 12px;border-radius:6px;background:var(--hover)}.hook-dialog-actions button{display:inline-flex;align-items:center;gap:6px}.hook-primary{background:var(--blue)!important;color:white}.hook-settings{margin-top:16px;border:1px solid var(--border);border-radius:10px;background:var(--panel);padding:20px}.hook-section-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:15px}.hook-section-heading h2{font-size:13px;margin:0 0 8px}.hook-section-heading p{font-size:12px;color:var(--muted);margin:0 0 10px}.hook-check{display:flex;align-items:center;gap:6px;white-space:nowrap}.hook-provider{padding-top:17px;margin-top:12px;border-top:1px solid var(--border)}.hook-provider-heading{display:flex;align-items:center;justify-content:space-between;font-size:13px;margin-bottom:12px}.hook-action{color:var(--blue)}.hook-target{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;padding:10px 0;font-size:12px}.hook-target small{display:block;font-size:10px;color:var(--muted);margin-top:4px}.hook-state{font-size:11px;color:var(--muted)}.hook-state.installed{color:#31a783}.hook-state.error,.hook-state.needs-update{color:#d49542}.hook-error{font-size:12px;line-height:1.5;color:#d07878;overflow-wrap:anywhere;width:100%}.hook-message{font-size:12px;color:var(--blue);line-height:1.5}.hook-problems{max-height:110px;overflow:auto;font-size:11px;color:#d07878}.hook-paths{font-size:11px;color:var(--muted);margin:8px 0}.hook-paths summary{cursor:pointer}.hook-paths code{display:block;margin-top:7px;overflow-wrap:anywhere;font-size:10px}.hook-trust{margin:18px 0 0}button:disabled{opacity:.5;cursor:default}button:focus-visible,input:focus-visible,summary:focus-visible{outline:2px solid var(--blue);outline-offset:3px}
.hook-section{margin-bottom:38px;scroll-margin-top:24px;outline:none}.section-title{font-size:20px;letter-spacing:-.35px;margin:0 0 8px}.section-intro{font-size:12px;color:var(--muted);line-height:1.6;margin:0 0 18px}.hook-settings h3{font-size:13px;margin:0}.hook-overview{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin:8px 0 18px}.hook-overview>div{display:flex;flex-direction:column;gap:7px;font-size:12px}.hook-overview span{font-size:11px;color:var(--muted)}.hook-global-actions,.hook-provider-actions{display:flex;flex-wrap:wrap;gap:8px}
.hook-reason{width:100%;margin:0;color:var(--muted);font-size:10px}
.mcp-choice{display:flex;gap:12px;align-items:flex-start;font-size:12px;margin:0 0 14px}.mcp-choice span{display:block}.mcp-choice small{display:block;color:var(--muted);line-height:1.5;margin-top:4px}
</style>
