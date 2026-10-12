<script setup lang="ts">
import { SwitchRoot,SwitchThumb } from 'reka-ui';
import { Monitor,Bot,Layers3,ShieldCheck,ArrowUpRight } from '@lucide/vue';
import type { CaptureStatus } from './transport.ts';
import { native,openAccessibilitySettings } from './transport.ts';
import type { CaptureSettings } from '../capture/settings.ts';
defineProps<{status:CaptureStatus|null;busy:boolean}>();
const emit=defineEmits<{change:[settings:Partial<CaptureSettings>];error:[message:string]}>();
const surfaces:Array<{key:keyof CaptureSettings;title:string;description:string;icon:typeof Monitor}>=[
 {key:'macosActivity',title:'macOS activity',description:'Foreground app, input idle time, and sleep or wake. Human time stays separate from agent time.',icon:Monitor},
 {key:'claudeHooks',title:'Claude hooks',description:'Session, tool, and subagent events from Claude. Requires the installed hook configuration.',icon:Bot},
 {key:'codexHooks',title:'Codex hooks',description:'Session, tool, and subagent events from Codex. Hooks must be installed and trusted in /hooks.',icon:Bot},
 {key:'orcaPolling',title:'Orca',description:'Discover terminals and orchestration runs, and sample worker activity. Overlap with hooks is counted once.',icon:Layers3},
 {key:'tokenUsage',title:'Token usage & limits',description:'Read local token counters for captured Claude and Codex sessions, and shared account limits reported by Orca.',icon:Bot},
];
async function openPermission(){try{await openAccessibilitySettings();}catch(e){emit('error',String(e));}}
</script>
<template>
<section class="capture-settings-page">
 <h1>Capture settings</h1><p class="settings-intro">Choose what Agent Time captures on this Mac.</p>
 <div class="surface-list">
  <div v-for="surface in surfaces" :key="surface.key" class="surface-row">
   <div class="surface-icon"><component :is="surface.icon" :size="20"/></div>
   <div class="surface-copy"><label :id="surface.key+'-label'" :for="surface.key"><strong>{{surface.title}}</strong></label><p>{{surface.description}}</p><small>{{status?.surfaces[surface.key]?(status.running?'Capture enabled':'Enabled · collector paused'):'Capture disabled'}}</small></div>
   <SwitchRoot :id="surface.key" :aria-labelledby="surface.key+'-label'" class="surface-switch" :model-value="status?.surfaces[surface.key]??false" :disabled="busy||!status" @update:model-value="emit('change',{[surface.key]:$event})"><SwitchThumb class="surface-thumb"/></SwitchRoot>
  </div>
 </div>
 <div class="permission-card"><ShieldCheck :size="19"/><div><h2>Accessibility permission</h2><strong>{{!status?.surfaces.macosActivity?'Activity capture disabled':!status.macos?'Checking permission…':status.macos.accessibilityTrusted?'Granted':'Not granted · basic activity available'}}</strong><p>Foreground app and idle tracking work without Accessibility. Grant it to read Orca’s focused window context. It does not yet identify the focused agent session.</p><button v-if="native" class="permission-button" @click="openPermission">Open System Settings <ArrowUpRight :size="13"/></button><p v-else>Manage permission in System Settings → Privacy &amp; Security → Accessibility.</p></div></div>
 <div class="settings-footnote"><p>Changes apply immediately and are saved automatically. Existing history is kept. Events received from disabled hooks are discarded.</p><p>These switches control capture; they do not install or remove agent hooks. Closing the window keeps capture running. Quit Agent Time to stop it.</p></div>
</section>
</template>
<style scoped>
.capture-settings-page{padding:30px 32px;overflow:auto;flex:1;max-width:920px;width:100%;align-self:center}h1{font-size:25px;letter-spacing:-.6px;margin:0 0 8px}h2{font-size:13px;margin:0 0 8px}.settings-intro{color:var(--muted);margin:0 0 25px}.surface-list{border:1px solid var(--border);border-radius:10px;background:var(--panel);overflow:hidden}.surface-row{display:flex;align-items:center;gap:16px;padding:20px;border-bottom:1px solid var(--border)}.surface-row:last-child{border:0}.surface-icon{color:var(--muted);align-self:flex-start;padding-top:2px}.surface-copy{flex:1}.surface-copy strong{font-size:13px}.surface-copy p,.permission-card p{color:var(--muted);font-size:12px;line-height:1.6;margin:6px 0}.surface-copy small{font-size:10px;color:var(--muted)}.surface-switch{width:36px;height:21px;border-radius:20px;background:var(--border);padding:2px;flex-shrink:0;transition:background .15s}.surface-switch[data-state=checked]{background:var(--blue)}.surface-thumb{display:block;width:17px;height:17px;background:white;border-radius:50%;box-shadow:0 1px 3px #0003;transition:transform .15s}.surface-thumb[data-state=checked]{transform:translateX(15px)}.permission-card{display:flex;gap:14px;margin-top:22px;padding:20px;background:var(--panel);border:1px solid var(--border);border-radius:10px}.permission-card>svg{color:var(--muted);flex-shrink:0}.permission-card strong{font-size:11px;font-weight:500}.permission-button{display:flex;align-items:center;gap:6px;color:var(--blue);padding:7px 0 0;font-size:12px}.settings-footnote{font-size:11px;color:var(--muted);line-height:1.6;margin-top:20px}.settings-footnote p{margin:6px 0}@media(prefers-reduced-motion:reduce){.surface-switch,.surface-thumb{transition:none}}
</style>
