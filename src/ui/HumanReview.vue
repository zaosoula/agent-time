<script setup lang="ts">
import {computed,ref,watch} from 'vue';
import {Check,ChevronRight,RotateCcw} from '@lucide/vue';
import type {Interval,Summary} from '../capture/events.ts';
import {groupHumanReview,type HumanReviewGroup} from '../capture/human-review.ts';
import {transport,type WebsiteProjectStatus} from './transport.ts';

const props=defineProps<{intervals:Interval[];siteFilter:string}>();
const emit=defineEmits<{changed:[summary:Summary];clearFilter:[]}>();
const projects=ref<WebsiteProjectStatus|null>(null),choices=ref<Record<string,string>>({}),error=ref(''),pending=ref(''),expanded=ref(false),showAll=ref(false),limit=ref(30),selectedGroups=ref<Record<string,boolean>>({}),bulkProject=ref('');
let projectsLoading=false;
const id=(group:HumanReviewGroup)=>`${group.start}:${group.key}`;
const clock=(seconds:number)=>new Date(seconds*1000).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});
const duration=(seconds:number)=>seconds>=60?`${Math.round(seconds/60)}m`:`${Math.round(seconds)}s`;
const name=(path:string)=>path.split('/').filter(Boolean).at(-1)||path;
const projectPaths=computed(()=>[...new Set([...(projects.value?.projects||[]),...props.intervals.flatMap(i=>i.workspaceId?[i.workspaceId.split('::').at(-1)!]:[])])].filter(path=>path.startsWith('/')).sort((a,b)=>name(a).localeCompare(name(b))));
const groups=computed(()=>groupHumanReview(props.intervals).filter(group=>!props.siteFilter||Boolean(group.browserUrl?.startsWith(props.siteFilter)||group.browserOrigin===props.siteFilter)));
const needs=computed(()=>groups.value.filter(group=>!group.projectPath&&!group.userAttribution).sort((a,b)=>b.seconds-a.seconds||b.start-a.start));
const unmatchedSeconds=computed(()=>needs.value.reduce((total,group)=>total+group.seconds,0));
const visible=computed(()=>(showAll.value?groups.value:needs.value).slice(0,limit.value));
const bulkGroups=computed(()=>groups.value.filter(group=>selectedGroups.value[id(group)]));
async function bulkAssign(){
 if(!bulkProject.value){error.value='Choose a project folder first.';return;}
 const pairs=[...new Map(bulkGroups.value.flatMap(group=>group.pairs).map(pair=>[pair.join(':'),pair])).values()];
 if(!pairs.length||pairs.length>500){error.value='Select up to 500 recorded intervals at a time.';return;}
 pending.value='bulk';error.value='';
 try{emit('changed',await transport.setHumanDecision(pairs,'assigned',bulkProject.value));selectedGroups.value={};}
 catch(cause){error.value=String(cause);}
 finally{pending.value='';}
}
function suggestion(group:HumanReviewGroup){
 return projects.value?.matches.find(match=>group.browserUrl?.startsWith(match.key)||group.browserOrigin===match.key)?.suggestions[0];
}
function selected(group:HumanReviewGroup){return choices.value[id(group)]||group.projectPath||'';}
function futurePattern(group:HumanReviewGroup){
 if(!group.browserUrl&&!group.browserOrigin)return '';
 try{const url=new URL(group.browserUrl||group.browserOrigin!);if(url.hostname==='github.com'){const parts=url.pathname.split('/').filter(Boolean);return parts.length>=2?`${url.origin}/${parts[0]}/${parts[1]}`:'';}if(['localhost','127.0.0.1','::1'].includes(url.hostname)||url.hostname.endsWith('.localhost'))return url.origin;return '';}catch{return '';}
}
async function decide(group:HumanReviewGroup,mode:'assigned'|'unassigned'|'clear'){
 const key=id(group),path=mode==='assigned'?selected(group):undefined;
 if(mode==='assigned'&&!path){error.value='Choose a project folder first.';return;}
 pending.value=key;error.value='';
 try{emit('changed',await transport.setHumanDecision(group.pairs,mode,path));}
 catch(cause){error.value=String(cause);}
 finally{pending.value='';}
}
async function saveRule(group:HumanReviewGroup){
 const path=selected(group),pattern=futurePattern(group);if(!path||!pattern){error.value='Choose a project and a website first.';return;}
 pending.value=id(group);error.value='';
 try{projects.value=await transport.setWebsiteRule(pattern,path);}
 catch(cause){error.value=String(cause);}
 finally{pending.value='';}
}
async function loadProjects(){if(projects.value||projectsLoading)return;projectsLoading=true;try{projects.value=await transport.websiteProjects();}catch(cause){error.value=String(cause);}finally{projectsLoading=false;}}
watch(expanded,open=>{if(open)void loadProjects();});
watch(()=>props.siteFilter,filter=>{if(filter){expanded.value=true;showAll.value=false;limit.value=30;}},{immediate:true});
</script>

<template>
 <section class="human-review">
  <button class="human-review-heading" :aria-expanded="expanded" @click="expanded=!expanded"><span><ChevronRight :size="14" :class="{expanded}"/><strong>Review human activity</strong><small>{{duration(unmatchedSeconds)}} unmatched · {{needs.length}} groups</small></span><span>{{expanded?'Hide':'Review'}}</span></button>
  <div v-if="expanded" class="human-review-body">
   <p>Assign recorded foreground time to a project. This changes the timesheet; the original capture stays intact.</p>
   <div class="human-review-controls"><button :class="{active:!showAll}" @click="showAll=false;limit=30">Needs review · longest first</button><button :class="{active:showAll}" @click="showAll=true;limit=30">All activity · recent first</button><span v-if="siteFilter">Showing {{siteFilter}} <button @click="emit('clearFilter')">Clear filter</button></span></div>
   <div v-if="visible.length" class="human-review-bulk"><button :disabled="Boolean(pending)" @click="selectedGroups=Object.fromEntries(visible.map(group=>[id(group),true]))">Select visible</button><button :disabled="Boolean(pending)" @click="selectedGroups={}">Clear selection</button><span>{{bulkGroups.length}} selected</span><input v-model="bulkProject" list="human-bulk-projects" aria-label="Project for selected activity" placeholder="Project for selected activity"/><datalist id="human-bulk-projects"><option v-for="path in projectPaths" :key="path" :value="path">{{name(path)}}</option></datalist><button :disabled="Boolean(pending)||!bulkGroups.length" @click="bulkAssign">Assign selected</button></div>
   <p v-if="error" class="human-review-error" role="alert">{{error}}</p>
   <div v-if="!visible.length" class="human-review-empty">{{siteFilter?'No recorded activity for this site on the selected day.':showAll?'No human activity recorded on this day.':'Everything recorded on this day has a project or has been reviewed.'}}</div>
   <article v-for="group in visible" :key="id(group)" class="human-review-row">
    <label class="human-review-select"><input v-model="selectedGroups[id(group)]" type="checkbox" :aria-label="`Select ${group.label} at ${clock(group.start)}`"/> Select for bulk assignment</label>
    <div class="human-review-row-head"><div><strong>{{group.label}}</strong><small :title="group.detail">{{group.detail}}</small></div><span>{{clock(group.start)}}–{{clock(group.end)}} · {{duration(group.seconds)}}</span></div>
    <div class="human-review-evidence"><span v-if="group.userAttribution==='assigned'" class="human-review-user"><Check :size="12"/> User assigned to {{name(group.projectPath||'')}}</span><span v-else-if="group.userAttribution==='unassigned'" class="human-review-user">Reviewed · left unassigned</span><span v-else-if="group.projectPath">Captured as {{name(group.projectPath)}}</span><span v-else>Unmatched</span><span v-if="group.attributionReason" :class="{'human-review-conflict':group.attributionSource==='conflict'}">{{group.attributionReason}}</span><button v-if="suggestion(group)" :title="suggestion(group)!.detail" @click="choices[id(group)]=suggestion(group)!.projectPath">Use suggestion: {{name(suggestion(group)!.projectPath)}} · {{suggestion(group)!.source.replaceAll('_',' ')}}</button></div>
    <div class="human-review-actions"><input :list="`human-project-paths-${id(group)}`" :value="selected(group)" :aria-label="`Project for ${group.label}`" placeholder="Choose or enter project folder" @input="choices[id(group)]=($event.target as HTMLInputElement).value"/><datalist :id="`human-project-paths-${id(group)}`"><option v-for="path in projectPaths" :key="path" :value="path">{{name(path)}}</option></datalist><button :disabled="Boolean(pending)" @click="decide(group,'assigned')">Assign this activity</button><button v-if="!group.userAttribution" :disabled="Boolean(pending)" @click="decide(group,'unassigned')">Leave unassigned</button><button v-else :disabled="Boolean(pending)" @click="decide(group,'clear')"><RotateCcw :size="12"/> Undo</button></div>
    <div v-if="futurePattern(group)" class="human-review-future"><button :disabled="Boolean(pending)||!selected(group)" @click="saveRule(group)">Also match future visits to {{futurePattern(group)}}</button><small>Separate website rule; past visits stay as recorded until you review them.</small></div>
   </article>
   <button v-if="(showAll?groups:needs).length>limit" class="human-review-more" @click="limit+=30">Show more activity</button>
  </div>
 </section>
</template>

<style scoped>
.human-review{margin:16px 0;border:1px solid var(--border);border-radius:10px;background:var(--panel);overflow:hidden}.human-review-heading{display:flex;justify-content:space-between;align-items:center;width:100%;padding:15px 17px;border:0;background:transparent;color:var(--text);cursor:pointer;text-align:left}.human-review-heading>span:first-child{display:flex;align-items:center;gap:9px}.human-review-heading strong{font-size:12px}.human-review-heading small,.human-review-heading>span:last-child{font-size:10px;color:var(--muted)}.human-review-heading svg{transition:transform .15s}.human-review-heading svg.expanded{transform:rotate(90deg)}.human-review-body{border-top:1px solid var(--border);padding:15px 17px}.human-review-body>p{font-size:11px;color:var(--muted);margin:0 0 12px}.human-review-controls{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:12px}.human-review-controls>button,.human-review-controls span button{border:1px solid var(--border);border-radius:6px;background:transparent;color:var(--muted);font-size:10px;padding:5px 8px;cursor:pointer}.human-review-controls>button.active{color:var(--text);background:var(--hover)}.human-review-controls span{font-size:10px;color:var(--muted);margin-left:auto}.human-review-error{color:#d07878!important}.human-review-empty{font-size:11px;color:var(--muted);padding:17px 0}.human-review-row{padding:12px 0;border-top:1px solid var(--border)}.human-review-row-head{display:flex;justify-content:space-between;align-items:start;gap:12px;font-size:11px}.human-review-row-head>div{min-width:0}.human-review-row-head strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.human-review-row-head small{display:block;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:3px}.human-review-row-head>span{white-space:nowrap;color:var(--muted);font-variant-numeric:tabular-nums}.human-review-evidence{display:flex;flex-wrap:wrap;gap:10px;margin:8px 0;color:var(--muted);font-size:10px}.human-review-user{color:#55c49b;display:inline-flex;align-items:center;gap:4px}.human-review-actions{display:flex;flex-wrap:wrap;gap:6px}.human-review-actions input{flex:1 1 230px;min-width:0;border:1px solid var(--border);background:var(--hover);border-radius:6px;padding:7px 9px;color:var(--text);font-size:11px}.human-review-actions button,.human-review-future button,.human-review-more{border:1px solid var(--border);background:var(--hover);color:var(--text);border-radius:6px;padding:7px 9px;font-size:10px;cursor:pointer;display:inline-flex;align-items:center;gap:4px}.human-review-actions button:disabled,.human-review-future button:disabled{opacity:.5;cursor:default}.human-review-future{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-top:7px}.human-review-future button{background:transparent}.human-review-future small{font-size:9px;color:var(--muted)}.human-review-more{margin-top:12px}
.human-review-evidence button{border:1px solid var(--border);border-radius:5px;background:transparent;color:var(--muted);padding:2px 6px;font-size:10px;cursor:pointer}
.human-review-bulk{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:0 0 12px}.human-review-bulk button{border:1px solid var(--border);border-radius:6px;background:var(--hover);padding:6px 8px;color:var(--text);font-size:10px}.human-review-bulk button:disabled{opacity:.5}.human-review-bulk span,.human-review-select{font-size:10px;color:var(--muted)}.human-review-bulk input{flex:1 1 190px;min-width:0;border:1px solid var(--border);background:var(--hover);border-radius:6px;padding:6px 8px;color:var(--text);font-size:10px}.human-review-select{display:flex;align-items:center;gap:5px;margin-bottom:7px}
.human-review-conflict{color:#d49542}
</style>
