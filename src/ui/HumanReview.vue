<script setup lang="ts">
import {computed,ref,watch,onMounted,onUnmounted,nextTick} from 'vue';
import {Check,ChevronRight,RotateCcw} from '@lucide/vue';
import type {Interval,Summary} from '../capture/events.ts';
import {groupHumanReview,type HumanReviewGroup} from '../capture/human-review.ts';
import {minuteCreditSeconds} from '../capture/correlate.ts';
import type {ManualNote} from '../capture/store.ts';
import {transport,type WebsiteProjectStatus} from './transport.ts';
import ProjectPicker from './ProjectPicker.vue';

const props=defineProps<{intervals:Interval[];siteFilter:string;date:string;notes:ManualNote[]}>();
const emit=defineEmits<{changed:[summary:Summary];clearFilter:[];note:[start:number,end:number,label:string]}>();
const projects=ref<WebsiteProjectStatus|null>(null),choices=ref<Record<string,string>>({}),error=ref(''),notice=ref(''),pending=ref(''),expanded=ref(false),viewMode=ref<'needs'|'conflicts'|'reviewed'|'all'>('needs'),filterText=ref(''),limit=ref(30),selectedGroups=ref<Record<string,boolean>>({}),bulkProject=ref(''),focused=ref(''),rulePreview=ref('');
const undoAction=ref<(()=>Promise<void>)|null>(null);
let projectsLoading=false;
const id=(group:HumanReviewGroup)=>`${group.start}:${group.key}`;
const clock=(seconds:number)=>new Date(seconds*1000).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});
const duration=(seconds:number)=>seconds>=60?`${Math.round(seconds/60)}m`:`${Math.round(seconds)}s`;
const name=(path:string)=>path.split('/').filter(Boolean).at(-1)||path;
const projectPaths=computed(()=>[...new Set([...(projects.value?.projects||[]),...props.intervals.flatMap(i=>i.workspaceId?[i.workspaceId.split('::').at(-1)!]:[])])].filter(path=>path.startsWith('/')).sort((a,b)=>name(a).localeCompare(name(b))));
const groups=computed(()=>groupHumanReview(props.intervals).filter(group=>!props.siteFilter||Boolean(group.browserUrl?.startsWith(props.siteFilter)||group.browserOrigin===props.siteFilter)));
const needs=computed(()=>groups.value.filter(group=>!group.projectPath&&!group.userAttribution).sort((a,b)=>b.seconds-a.seconds||b.start-a.start));
const conflicts=computed(()=>groups.value.filter(group=>group.attributionSource==='conflict'&&!group.userAttribution).sort((a,b)=>b.seconds-a.seconds||b.start-a.start));
const reviewed=computed(()=>groups.value.filter(group=>Boolean(group.userAttribution)).sort((a,b)=>b.start-a.start));
const unmatchedSeconds=computed(()=>needs.value.reduce((total,group)=>total+group.seconds,0));
const activeGroups=computed(()=>{
 const rows=viewMode.value==='all'?groups.value:viewMode.value==='conflicts'?conflicts.value:viewMode.value==='reviewed'?reviewed.value:needs.value;
 const query=filterText.value.trim().toLocaleLowerCase();
 return query?rows.filter(group=>[group.label,group.detail,group.projectPath,group.attributionSource,group.attributionReason].some(value=>value?.toLocaleLowerCase().includes(query))):rows;
});
const visible=computed(()=>activeGroups.value.slice(0,limit.value));
const bulkGroups=computed(()=>activeGroups.value.filter(group=>selectedGroups.value[id(group)]));
const selectedSeconds=computed(()=>bulkGroups.value.reduce((total,group)=>total+group.seconds,0));
const bulkProjectBefore=computed(()=>minuteCreditSeconds(props.intervals.filter(interval=>interval.state==='human'&&interval.workspaceId?.split('::').at(-1)===bulkProject.value).map(interval=>[interval.start,interval.end])));
const bulkProjectAfter=computed(()=>{const pairs=new Set(bulkGroups.value.flatMap(group=>group.pairs.map(pair=>pair.join(':'))));return minuteCreditSeconds(props.intervals.filter(interval=>interval.state==='human'&&(interval.workspaceId?.split('::').at(-1)===bulkProject.value||pairs.has(interval.sourceEventIds.join(':')))).map(interval=>[interval.start,interval.end]));});
const reviewStateKey=computed(()=>`agent-time.review:${props.date}`);
watch(reviewStateKey,key=>{try{const saved=JSON.parse(sessionStorage.getItem(key)||'{}');expanded.value=Boolean(saved.expanded);viewMode.value=['needs','conflicts','reviewed','all'].includes(saved.viewMode)?saved.viewMode:'needs';filterText.value=typeof saved.filterText==='string'?saved.filterText:'';focused.value=typeof saved.focused==='string'?saved.focused:'';}catch{/* Ignore old review state. */}},{immediate:true});
watch([expanded,viewMode,filterText,focused],()=>sessionStorage.setItem(reviewStateKey.value,JSON.stringify({expanded:expanded.value,viewMode:viewMode.value,filterText:filterText.value,focused:focused.value})));
async function undo(){if(undoAction.value){await undoAction.value();undoAction.value=null;notice.value='Review decision undone.';}}
function keyboard(event:KeyboardEvent){
 if(!expanded.value||event.target instanceof HTMLInputElement||event.target instanceof HTMLTextAreaElement)return;
 if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='z'){event.preventDefault();void undo();return;}
 if(event.metaKey||event.ctrlKey||event.altKey)return;
 const current=visible.value.findIndex(group=>id(group)===focused.value);
 if(event.key==='j'){event.preventDefault();const unresolved=needs.value.filter(group=>!filterText.value||[group.label,group.detail,group.projectPath].some(value=>value?.toLocaleLowerCase().includes(filterText.value.toLocaleLowerCase())));const currentUnresolved=unresolved.findIndex(group=>id(group)===focused.value);const next=unresolved[Math.min(unresolved.length-1,currentUnresolved+1)];viewMode.value='needs';if(next)void focusGroup(next);}
 if(event.key==='a'&&current>=0){event.preventDefault();void decide(visible.value[current],'assigned');}
 if(event.key==='u'&&current>=0){event.preventDefault();void decide(visible.value[current],'unassigned');}
}
async function focusGroup(group:HumanReviewGroup){focused.value=id(group);await nextTick();document.getElementById(`review-${id(group)}`)?.focus();}
onMounted(()=>window.addEventListener('keydown',keyboard));onUnmounted(()=>window.removeEventListener('keydown',keyboard));
async function bulkAssign(){
 if(!bulkProject.value){error.value='Choose a project folder first.';return;}
 const pairs=[...new Map(bulkGroups.value.flatMap(group=>group.pairs).map(pair=>[pair.join(':'),pair])).values()];
 if(!pairs.length||pairs.length>500){error.value='Select up to 500 recorded intervals at a time.';return;}
 pending.value='bulk';error.value='';
 try{const previous=bulkGroups.value.map(group=>({pairs:group.pairs,mode:(group.userAttribution==='assigned'?'assigned':group.userAttribution==='unassigned'?'unassigned':'clear') as 'assigned'|'unassigned'|'clear',path:group.projectPath}));emit('changed',await transport.setHumanDecision(pairs,'assigned',bulkProject.value));undoAction.value=async()=>{for(const item of previous)emit('changed',await transport.setHumanDecision(item.pairs,item.mode,item.path));};notice.value=`Assigned ${duration(selectedSeconds.value)} across ${bulkGroups.value.length} groups to ${name(bulkProject.value)}. Original capture retained.`;selectedGroups.value={};}
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
 try{emit('changed',await transport.setHumanDecision(group.pairs,mode,path));const prior=group.userAttribution==='assigned'?'assigned':group.userAttribution==='unassigned'?'unassigned':'clear';undoAction.value=async()=>emit('changed',await transport.setHumanDecision(group.pairs,prior,group.projectPath));notice.value=`${duration(group.seconds)} ${mode==='assigned'?`assigned to ${name(path!)}`:mode==='unassigned'?'reviewed as unassigned':'returned to captured attribution'}. Original capture retained.`;focused.value=key;}
 catch(cause){error.value=String(cause);}
 finally{pending.value='';}
}
async function saveRule(group:HumanReviewGroup){
 const path=selected(group),pattern=futurePattern(group);if(!path||!pattern){error.value='Choose a project and a website first.';return;}
 pending.value=id(group);error.value='';
 try{projects.value=await transport.setWebsiteRule(pattern,path);rulePreview.value='';notice.value=`Future visits matching ${pattern} will be attributed to ${name(path)}. Past activity is unchanged.`;}
 catch(cause){error.value=String(cause);}
 finally{pending.value='';}
}
async function loadProjects(){if(projects.value||projectsLoading)return;projectsLoading=true;try{projects.value=await transport.websiteProjects();}catch(cause){error.value=String(cause);}finally{projectsLoading=false;}}
watch(expanded,open=>{if(open)void loadProjects();},{immediate:true});
watch(()=>props.siteFilter,filter=>{if(filter){expanded.value=true;viewMode.value='needs';limit.value=30;}},{immediate:true});
function previewRule(group:HumanReviewGroup){rulePreview.value=id(group);}
async function assignSuggestion(group:HumanReviewGroup){const match=suggestion(group);if(!match)return;choices.value[id(group)]=match.projectPath;await decide(group,'assigned');}
</script>

<template>
 <section class="human-review">
  <button class="human-review-heading" :aria-expanded="expanded" @click="expanded=!expanded"><span><ChevronRight :size="14" :class="{expanded}"/><strong>Review human activity</strong><small>{{duration(unmatchedSeconds)}} unmatched · {{needs.length}} groups</small></span><span>{{expanded?'Hide':'Review'}}</span></button>
  <div v-if="expanded" class="human-review-body">
   <p>Assign recorded foreground time to a project. This changes the timesheet; the original capture stays intact.</p>
   <div class="human-review-controls"><button :class="{active:viewMode==='needs'}" @click="viewMode='needs';limit=30">Needs review · longest first</button><button :class="{active:viewMode==='conflicts'}" @click="viewMode='conflicts';limit=30">Conflicting evidence · {{conflicts.length}}</button><button :class="{active:viewMode==='reviewed'}" @click="viewMode='reviewed';limit=30">Reviewed · {{reviewed.length}}</button><button :class="{active:viewMode==='all'}" @click="viewMode='all';limit=30">All activity · recent first</button><span v-if="siteFilter">Showing {{siteFilter}} <button @click="emit('clearFilter')">Clear filter</button></span></div>
   <input v-model="filterText" class="human-review-filter" type="search" aria-label="Filter activity by app, website, project, or evidence" placeholder="Filter app, website, project, or evidence"/>
   <div v-if="visible.length" class="human-review-bulk"><button :disabled="Boolean(pending)" @click="selectedGroups=Object.fromEntries(visible.map(group=>[id(group),true]))">Select visible</button><button :disabled="Boolean(pending)" @click="selectedGroups={}">Clear selection</button><span>{{bulkGroups.length}} selected · {{duration(selectedSeconds)}} affected</span><ProjectPicker v-model="bulkProject" :paths="projectPaths" label="Project for selected activity"/><span v-if="bulkProject&&bulkGroups.length" class="bulk-impact">{{name(bulkProject)}}: {{duration(bulkProjectBefore)}} → {{duration(bulkProjectAfter)}} credited</span><button :disabled="Boolean(pending)||!bulkGroups.length||!bulkProject" @click="bulkAssign">Assign {{duration(selectedSeconds)}} to {{name(bulkProject)}}</button></div>
   <p v-if="error" class="human-review-error" role="alert">{{error}}</p>
   <p v-if="notice" class="human-review-notice" role="status">{{notice}} <button v-if="undoAction" @click="undo">Undo ⌘Z</button></p>
   <p class="human-review-shortcuts">Keyboard: J next unresolved · A assign selected project · U leave unassigned · ⌘Z undo</p>
   <div v-if="!visible.length" class="human-review-empty">{{filterText?'No activity matches this filter.':siteFilter?'No recorded activity for this site on the selected day.':viewMode==='all'?'No human activity recorded on this day.':viewMode==='reviewed'?'No reviewed activity on this day.':viewMode==='conflicts'?'No unresolved attribution conflicts on this day.':'Everything recorded on this day has a project or has been reviewed.'}}</div>
   <article v-for="group in visible" :id="`review-${id(group)}`" :key="id(group)" class="human-review-row" :class="{focused:focused===id(group)}" tabindex="0" @focus="focused=id(group)">
    <label class="human-review-select"><input v-model="selectedGroups[id(group)]" type="checkbox" :aria-label="`Select ${group.label} at ${clock(group.start)}`"/> Select for bulk assignment</label>
    <div class="human-review-row-head"><div><strong>{{group.label}}</strong><small :title="group.detail">{{group.detail}}</small></div><span>{{clock(group.start)}}–{{clock(group.end)}} · {{duration(group.seconds)}}</span></div>
    <div class="human-review-evidence"><span v-if="group.userAttribution==='assigned'" class="human-review-user"><Check :size="12"/> User assigned to {{name(group.projectPath||'')}}</span><span v-else-if="group.userAttribution==='unassigned'" class="human-review-user">Reviewed · left unassigned</span><span v-else-if="group.projectPath">Captured as {{name(group.projectPath)}}</span><span v-else>Unmatched</span><span v-if="group.attributionReason" :class="{'human-review-conflict':group.attributionSource==='conflict'}">{{group.attributionReason}}</span><button v-if="suggestion(group)" :title="suggestion(group)!.detail" :disabled="Boolean(pending)" @click="assignSuggestion(group)">Assign {{duration(group.seconds)}} to {{name(suggestion(group)!.projectPath)}} <small>Suggested by {{suggestion(group)!.source.replaceAll('_',' ')}} · {{suggestion(group)!.detail}}</small></button></div>
    <details class="human-review-proof"><summary>Recorded evidence</summary><dl><dt>Foreground</dt><dd>{{group.label}}</dd><dt>Source detail</dt><dd>{{group.detail}}</dd><dt>Project evidence</dt><dd>{{group.attributionReason||'No project evidence was captured for this activity.'}}</dd><dt>Observation pairs</dt><dd>{{group.pairs.length}} · original captured events are retained when you assign or undo</dd></dl></details>
    <div class="human-review-actions"><ProjectPicker :model-value="selected(group)" :paths="projectPaths" :label="`Project for ${group.label}`" @update:model-value="choices[id(group)]=$event"/><button :disabled="Boolean(pending)||!selected(group)" @click="decide(group,'assigned')">Assign {{duration(group.seconds)}}</button><button v-if="!group.userAttribution" :disabled="Boolean(pending)" @click="decide(group,'unassigned')">Leave unassigned</button><button v-else :disabled="Boolean(pending)" @click="decide(group,'clear')"><RotateCcw :size="12"/> Undo</button><button @click="emit('note',group.start,group.end,group.label)">Add note</button></div>
    <div v-for="item in notes.filter(note=>note.start>=group.start&&note.end<=group.end)" :key="item.id" class="human-review-note"><strong>Note</strong><span>{{item.note}}</span></div>
    <div v-if="futurePattern(group)" class="human-review-future"><button :disabled="Boolean(pending)||!selected(group)" @click="previewRule(group)">Preview future website rule</button><div v-if="rulePreview===id(group)" class="human-review-rule-preview"><strong>Future visits only</strong><span>{{futurePattern(group)}} and pages beneath it → {{name(selected(group))}}</span><span>Example from this review: {{group.browserUrl||group.browserOrigin}}</span><small>Past recorded visits and current review decisions stay unchanged.</small><button :disabled="Boolean(pending)" @click="saveRule(group)">Save this rule</button></div></div>
   </article>
   <button v-if="activeGroups.length>limit" class="human-review-more" @click="limit+=30">Show more activity</button>
  </div>
 </section>
</template>

<style scoped>
.human-review{margin:16px 0;border:1px solid var(--border);border-radius:10px;background:var(--panel);overflow:hidden}.human-review-heading{display:flex;justify-content:space-between;align-items:center;width:100%;padding:15px 17px;border:0;background:transparent;color:var(--text);cursor:pointer;text-align:left}.human-review-heading>span:first-child{display:flex;align-items:center;gap:9px}.human-review-heading strong{font-size:12px}.human-review-heading small,.human-review-heading>span:last-child{font-size:10px;color:var(--muted)}.human-review-heading svg{transition:transform .15s}.human-review-heading svg.expanded{transform:rotate(90deg)}.human-review-body{border-top:1px solid var(--border);padding:15px 17px}.human-review-body>p{font-size:11px;color:var(--muted);margin:0 0 12px}.human-review-controls{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:12px}.human-review-controls>button,.human-review-controls span button{border:1px solid var(--border);border-radius:6px;background:transparent;color:var(--muted);font-size:10px;padding:5px 8px;cursor:pointer}.human-review-controls>button.active{color:var(--text);background:var(--hover)}.human-review-controls span{font-size:10px;color:var(--muted);margin-left:auto}.human-review-error{color:#d07878!important}.human-review-empty{font-size:11px;color:var(--muted);padding:17px 0}.human-review-row{padding:12px 0;border-top:1px solid var(--border)}.human-review-row-head{display:flex;justify-content:space-between;align-items:start;gap:12px;font-size:11px}.human-review-row-head>div{min-width:0}.human-review-row-head strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.human-review-row-head small{display:block;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:3px}.human-review-row-head>span{white-space:nowrap;color:var(--muted);font-variant-numeric:tabular-nums}.human-review-evidence{display:flex;flex-wrap:wrap;gap:10px;margin:8px 0;color:var(--muted);font-size:10px}.human-review-user{color:#55c49b;display:inline-flex;align-items:center;gap:4px}.human-review-actions{display:flex;flex-wrap:wrap;gap:6px}.human-review-actions input{flex:1 1 230px;min-width:0;border:1px solid var(--border);background:var(--hover);border-radius:6px;padding:7px 9px;color:var(--text);font-size:11px}.human-review-actions button,.human-review-future button,.human-review-more{border:1px solid var(--border);background:var(--hover);color:var(--text);border-radius:6px;padding:7px 9px;font-size:10px;cursor:pointer;display:inline-flex;align-items:center;gap:4px}.human-review-actions button:disabled,.human-review-future button:disabled{opacity:.5;cursor:default}.human-review-future{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-top:7px}.human-review-future button{background:transparent}.human-review-future small{font-size:9px;color:var(--muted)}.human-review-more{margin-top:12px}
.human-review-evidence button{border:1px solid var(--border);border-radius:5px;background:transparent;color:var(--muted);padding:2px 6px;font-size:10px;cursor:pointer}
.human-review-bulk{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:0 0 12px}.human-review-bulk button{border:1px solid var(--border);border-radius:6px;background:var(--hover);padding:6px 8px;color:var(--text);font-size:10px}.human-review-bulk button:disabled{opacity:.5}.human-review-bulk span,.human-review-select{font-size:10px;color:var(--muted)}.human-review-bulk input{flex:1 1 190px;min-width:0;border:1px solid var(--border);background:var(--hover);border-radius:6px;padding:6px 8px;color:var(--text);font-size:10px}.human-review-select{display:flex;align-items:center;gap:5px;margin-bottom:7px}
.human-review-conflict{color:#d49542}
.human-review-filter{width:100%;box-sizing:border-box;margin:0 0 12px;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--hover);color:var(--text);font-size:11px}.human-review-proof{font-size:10px;color:var(--muted);margin:0 0 9px}.human-review-proof summary{cursor:pointer;color:var(--blue)}.human-review-proof dl{display:grid;grid-template-columns:105px minmax(0,1fr);gap:5px 9px;margin:8px 0}.human-review-proof dt{color:var(--muted)}.human-review-proof dd{margin:0;overflow-wrap:anywhere;color:var(--text)}
.human-review-row{padding:16px 0}.human-review-row:focus-visible,.human-review-row.focused{outline:2px solid var(--blue);outline-offset:-2px;border-radius:6px}.human-review-row-head,.human-review-actions button,.human-review-bulk button{font-size:12px}.human-review-row-head small,.human-review-evidence,.human-review-proof,.human-review-controls>button,.human-review-controls span button{font-size:11px}.human-review-actions button,.human-review-bulk button{min-height:34px}.human-review-notice{display:flex;align-items:center;gap:12px;color:#55c49b!important}.human-review-notice button{color:var(--blue)}.human-review-shortcuts{font-size:10px!important}.human-review-rule-preview{display:flex;flex-direction:column;gap:5px;width:100%;padding:10px;border:1px solid var(--border);border-radius:6px;font-size:11px}.human-review-rule-preview button{align-self:flex-start;color:var(--blue)}
.human-review{overflow:visible}.human-review-bulk .bulk-impact{margin-left:0;color:var(--text);font-variant-numeric:tabular-nums}
.human-review-evidence button{max-width:100%;text-align:left;color:var(--blue);overflow-wrap:anywhere}.human-review-evidence button small{display:block;margin-top:3px;color:var(--muted);font-size:10px}
.human-review-note{display:flex;align-items:start;gap:8px;margin-top:8px;padding:8px;border-left:2px solid var(--blue);background:var(--hover);font-size:11px;overflow-wrap:anywhere}.human-review-note strong{color:var(--blue)}
</style>
