<script setup lang="ts">
import {computed,ref,watch} from 'vue';
import {CheckCircle2,CircleHelp} from '@lucide/vue';
import type {CaptureStatus} from './transport.ts';
import type {HookInstallationStatus} from '../capture/hook-installation.ts';
import type {CaptureHealth} from '../capture/health.ts';
const props=defineProps<{status:CaptureStatus|null;hooks:HookInstallationStatus|null;health:CaptureHealth|null;busy:boolean}>();
const emit=defineEmits<{health:[];settings:[];hooks:[];start:[]}>();
const dismissed=ref(false);
const key=computed(()=>`agent-time.capture-verified:${props.hooks?.runtimeVersion||'mac'}`);
watch(key,value=>{dismissed.value=localStorage.getItem(value)==='1';},{immediate:true});
const enabledAgents=computed(()=>props.status?.sources.filter(source=>source.kind==='agent'&&props.status?.surfaces[source.setting])||[]);
const macEnabled=computed(()=>props.status?.surfaces.macosActivity===true);
const hooksCurrent=computed(()=>enabledAgents.value.length>0&&enabledAgents.value.every(agent=>{
 const targets=props.hooks?.targets.filter(target=>target.provider===agent.id)||[];
 return targets.length>0&&targets.every(target=>target.state==='installed');
}));
const deliveredAgent=computed(()=>enabledAgents.value.some(agent=>props.hooks?.targets.some(target=>target.provider===agent.id&&target.state==='installed'&&target.lastEvent!==null)));
const codexDelivered=computed(()=>{const targets=props.hooks?.targets.filter(target=>target.provider==='codex')||[];return targets.length>0&&targets.every(target=>target.state==='installed'&&target.lastEvent!==null);});
const deliveredMac=computed(()=>macEnabled.value&&typeof props.health?.latest.macos==='number'&&props.health.checkedAt-props.health.latest.macos<=60);
const macPermission=computed(()=>!macEnabled.value||!props.health?.sources.some(source=>source.id==='macos'&&source.state==='permission-limited'));
const allAgentsDelivered=computed(()=>enabledAgents.value.every(agent=>{
 const targets=props.hooks?.targets.filter(target=>target.provider===agent.id)||[];
 return targets.length>0&&targets.every(target=>target.state==='installed'&&target.lastEvent!==null);
}));
const verified=computed(()=>(enabledAgents.value.length>0||macEnabled.value)&&allAgentsDelivered.value&&(!macEnabled.value||deliveredMac.value));
const lastEvent=computed(()=>Math.max(0,...(props.hooks?.targets.filter(target=>enabledAgents.value.some(agent=>agent.id===target.provider)&&target.state==='installed').map(target=>target.lastEvent||0)||[]),deliveredMac.value?props.health?.latest.macos||0:0));
const stage=computed(()=>{
 if(!props.status)return 'checking';
 if(!props.status.running)return 'paused';
 if(!enabledAgents.value.length&&!macEnabled.value)return 'disabled';
 if(enabledAgents.value.length&&!hooksCurrent.value)return 'hooks';
 return verified.value?'verified':'waiting';
});
watch(stage,value=>{if(value!=='verified')dismissed.value=false;});
function dismiss(){dismissed.value=true;localStorage.setItem(key.value,'1');}
</script>
<template>
<section v-if="stage!=='checking'&&!dismissed" class="setup-verification" :class="{complete:stage==='verified'}" aria-label="Capture setup verification">
 <CheckCircle2 v-if="stage==='verified'" :size="18"/><CircleHelp v-else :size="18"/>
 <div><strong>{{stage==='verified'?'Capture verified':stage==='paused'?'Capture is paused':stage==='disabled'?'Choose what to capture':stage==='hooks'?'Connect your agent hooks':'Waiting for the first captured event'}}</strong>
  <p v-if="stage==='verified'">Every enabled source has delivered an event; the latest was at {{new Date(lastEvent*1000).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})}}. Check Capture health if activity stops appearing.</p>
  <p v-else-if="stage==='paused'">Start capture to check that events reach Agent Time.</p>
  <p v-else-if="stage==='disabled'">Enable Mac activity or an agent in Settings, then verify one real observation.</p>
  <p v-else-if="stage==='hooks'">Install or repair the enabled agent hooks. In Codex, trust Agent Time in /hooks.</p>
  <p v-else>At least one enabled source has not delivered a recent event{{deliveredAgent||deliveredMac?' even though another source is working':''}}. Start a new agent session or use your Mac for a few seconds. A configured hook alone does not confirm delivery.</p>
  <ol class="setup-checklist"><li v-if="enabledAgents.length" :class="{done:hooksCurrent}">Agent hooks {{hooksCurrent?'installed':'need installation'}} <button v-if="!hooksCurrent" @click="emit('hooks')">Review hooks</button></li><li v-if="enabledAgents.some(agent=>agent.id==='codex')" :class="{done:codexDelivered}">Codex trust {{codexDelivered?'confirmed by a delivered event':'check in /hooks for each Codex account'}} <button v-if="!codexDelivered" @click="emit('hooks')">Open hook guidance</button></li><li v-if="macEnabled" :class="{done:macPermission}">Mac Accessibility {{macPermission?'ready or optional detail':'needs review for browser and tab detail'}} <button v-if="!macPermission" @click="emit('health')">Review permission</button></li><li :class="{done:verified}">First real event {{verified?'received from every enabled source':'pending from one or more enabled sources'}} <button v-if="!verified" @click="emit('health')">Check delivery</button></li></ol>
 </div>
 <button v-if="stage==='verified'" @click="dismiss">Done</button>
 <button v-else-if="stage==='paused'" :disabled="busy" @click="emit('start')">Start capture</button>
 <button v-else-if="stage==='disabled'" @click="emit('settings')">Open Settings</button>
 <button v-else-if="stage==='hooks'" @click="emit('hooks')">Review hooks</button>
 <button v-else @click="emit('health')">Check capture</button>
</section>
</template>
<style scoped>
.setup-verification{display:flex;align-items:flex-start;gap:11px;margin:0 0 18px;padding:13px 15px;border:1px solid #d4954260;border-radius:9px;background:#d4954214;font-size:11px}.setup-verification>svg{color:#c38329;flex:none;margin-top:1px}.setup-verification.complete{border-color:#31a78360;background:#31a78314}.setup-verification.complete>svg{color:#31a783}.setup-verification>div{flex:1;min-width:0}.setup-verification strong{font-size:12px}.setup-verification p{margin:4px 0 0;color:var(--muted);line-height:1.5}.setup-verification button{flex:none;color:var(--blue);font-size:11px;padding:4px 0}.setup-verification button:focus-visible{outline:2px solid var(--blue);outline-offset:3px}
.setup-checklist{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 16px;margin:10px 0 0;padding-left:18px;color:var(--muted);font-size:11px}.setup-checklist li.done{color:#31a783}.setup-checklist button{margin-left:5px;text-decoration:underline}@media(max-width:720px){.setup-checklist{grid-template-columns:1fr}}
</style>
