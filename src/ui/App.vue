<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { TabsRoot,TabsList,TabsTrigger,TabsContent,DialogRoot,DialogPortal,DialogOverlay,DialogContent,DialogTitle,DialogDescription,TooltipProvider,TooltipRoot,TooltipTrigger,TooltipPortal,TooltipContent } from 'reka-ui';
import { Clock3, CalendarDays, Layers3, Activity, Folder, ChevronRight, ChevronLeft, Settings2, Search, Play, Pause, Download, X, CircleHelp, Radio, Monitor, Globe2, Bot, ArrowUpRight, SlidersHorizontal, ShieldCheck } from '@lucide/vue';
import { transport,native,relaunchHookSetup,manualNoteTransport,dayReviewTransport,type CaptureStatus,type DayReviewStatus } from './transport.ts';
import CaptureSettingsPage from './CaptureSettings.vue';
import UsagePage from './UsagePage.vue';
import HookSetup from './HookSetup.vue';
import type {HookInstallationStatus} from '../capture/hook-installation.ts';
import type {CaptureHealth} from '../capture/health.ts';
import {outdatedHookTargets} from '../capture/hook-warning.ts';
import CaptureHealthPage from './CaptureHealth.vue';
import BetaUpdates from './BetaUpdates.vue';
import HumanReview from './HumanReview.vue';
import WeeklyReview from './WeeklyReview.vue';
import WorkOutcomes from './WorkOutcomes.vue';
import ManualNotes from './ManualNotes.vue';
import SetupVerification from './SetupVerification.vue';
import type { CaptureSettings } from '../capture/settings.ts';
import type {ManualNote} from '../capture/store.ts';
import type { Summary,Session,Interval } from '../capture/events.ts';
import { unionSeconds, minuteCreditSeconds } from '../capture/correlate.ts';
import { dailyCaptureIssues } from '../capture/daily.ts';
import {dayConfidence} from '../capture/day-confidence.ts';
import {groupHumanReview} from '../capture/human-review.ts';
import {unobservedGaps} from '../capture/gaps.ts';
import { humanIntervalsBySession } from '../capture/orca-focus.ts';
import { agentLoadSegments,creditedIntervals,groupTimelineProjects,type TimelineProjectGroup } from './timeline-groups.ts';
import { workloadAreaPath,workloadChartHeight,workloadChartWidth } from './workload-chart.ts';
import { clampTimeRange,initialTimelineRange,minimumTimelineSpan,panTimeRange,timelineTicks,zoomTimeRange,type TimeRange } from './timeline-viewport.ts';
import {indexSessionIntervals,intervalSessionKey,sessionIntervalKey} from './session-intervals.ts';
import {projectDisplay,projectLabel,sessionProject,workspaceProject,unassignedProject} from './project-identity.ts';
const betaUpdatesEnabled=import.meta.env.VITE_BETA_UPDATES==='1';
const empty:Summary={intervals:[],unresolved:[],coverage:[],sessions:[],humanSeconds:0,agentSeconds:0,elapsedSeconds:0,childAgentSeconds:0};
const summary=ref<Summary>(empty),status=ref<CaptureStatus|null>(null),error=ref(''),captureBusy=ref(false),settingsBusy=ref(false),project=ref('all'),search=ref(''),selected=ref<Session|null>(null),view=ref('timeline'),page=ref('today');
const hookStatus=ref<HookInstallationStatus|null>(null);
const captureHealth=ref<CaptureHealth|null>(null);
const sourceProblems=computed(()=>captureHealth.value?.sources.filter(source=>source.state==='stale'||source.state==='failed')||[]);
const sourceProblemNames=computed(()=>sourceProblems.value.map(source=>source.name).join(', '));
const outdatedHooks=computed(()=>outdatedHookTargets(status.value,hookStatus.value));
const outdatedAgents=computed(()=>[...new Set(outdatedHooks.value.map(target=>hookStatus.value?.agents.find(agent=>agent.id===target.provider)?.name||target.provider))].join(', '));
const timelineLimit=ref(40),tableLimit=ref(100);
const reviewRevision=ref(0);
const dayReview=ref<DayReviewStatus|null>(null),dayReviewBusy=ref(false),dayReviewError=ref('');
async function loadDayReview(){const date=selectedDate.value;try{const value=await dayReviewTransport.status(date);if(date===selectedDate.value){dayReview.value=value;dayReviewError.value='';}}catch(cause){if(date===selectedDate.value)dayReviewError.value=String(cause);}}
async function markDayReviewed(){dayReviewBusy.value=true;dayReviewError.value='';try{dayReview.value=await dayReviewTransport.mark(selectedDate.value);}catch(cause){dayReviewError.value=String(cause);}finally{dayReviewBusy.value=false;}}
const reviewSiteFilter=ref('');
const expandedRoots=ref<Record<string,boolean>>({});
const collapsedProjects=ref<Record<string,boolean>>({});
const collapsedActivities=ref<Record<string,boolean>>({});
const hoveredLoad=ref<{project:string;left:number;tooltipLeft:number;time:number;roots:number;children:number;credited:boolean;human:boolean}|null>(null);
const projectCollapsed=(name:string)=>collapsedProjects.value[name]!==false;
const activityKey=(projectName:string,kind:'mac'|'browser')=>`${projectName}:${kind}`;
const activityCollapsed=(projectName:string,kind:'mac'|'browser')=>collapsedActivities.value[activityKey(projectName,kind)]===true;
const toggleActivity=(projectName:string,kind:'mac'|'browser')=>{const key=activityKey(projectName,kind);collapsedActivities.value[key]=!collapsedActivities.value[key];};
const projectCaption=(group:TimelineProjectGroup)=>[
 group.sessions.some(s=>!s.child)?`${group.sessions.filter(s=>!s.child).length} sessions`:undefined,
 group.sessions.some(s=>s.child)?`${group.sessions.filter(s=>s.child).length} subagents`:undefined,
 !group.sessions.length&&group.macApps.length?`${group.macApps.length} apps`:undefined,
 !group.sessions.length&&group.websites.length?`${group.websites.length} websites`:undefined,
].filter(Boolean).join(' · ');
const busy=computed(()=>captureBusy.value||settingsBusy.value);
let refreshJob:Promise<void>|undefined,refreshRevision=0;
const dateString=(date:Date)=>`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
const selectedDate=ref(dateString(new Date()));
const viewport=ref<TimeRange|null>(null);
const now=ref(Date.now()/1000);
const isToday=computed(()=>selectedDate.value===dateString(new Date(now.value*1000)));
const dayStart=computed(()=>new Date(selectedDate.value+'T00:00:00').getTime()/1000);
const dayEnd=computed(()=>{const d=new Date(selectedDate.value+'T00:00:00');d.setDate(d.getDate()+1);return d.getTime()/1000;});
const fullDate=computed(()=>new Date(selectedDate.value+'T12:00:00').toLocaleDateString('en',{weekday:'long',month:'long',day:'numeric'}));
const workspacePath=(s:Session)=>s.cwd||s.workspaceId?.split('::').at(-1)||unassignedProject;
const projectName=sessionProject;
const projectFromWorkspace=workspaceProject;
const palette=['#6875db','#31a783','#d49542','#b278c5','#5b9cc4','#d07878'];
const color=(s:Session)=>palette[Math.max(0,projects.value.indexOf(projectName(s)))%palette.length];
const duration=(seconds:number)=>{const mins=Math.floor(seconds/60);return mins>=60?`${Math.floor(mins/60)}h ${String(mins%60).padStart(2,'0')}m`:mins>0?`${mins}m`:`${Math.round(seconds)}s`;};
const clock=(seconds:number)=>new Date(seconds*1000).toLocaleTimeString('en',{hour:'2-digit',minute:'2-digit',hour12:false});
const preciseClock=(seconds:number)=>new Date(seconds*1000).toLocaleTimeString('en',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
const rangeClock=(seconds:number)=>seconds===dayEnd.value?'24:00':timelineSpan.value<=5*60?preciseClock(seconds):clock(seconds);
const tickClock=(seconds:number)=>timelineSpan.value<=5*60?preciseClock(seconds):clock(seconds);
const dayIntervals=computed(()=>summary.value.intervals.filter(i=>i.end>dayStart.value&&i.start<dayEnd.value).map(i=>({...i,start:Math.max(i.start,dayStart.value),end:Math.min(i.end,dayEnd.value)})));
const daySessionIntervals=computed(()=>indexSessionIntervals(dayIntervals.value));
const firstSessionByEvidence=computed(()=>{
 const sessions=new Map<string,Session>();
 for(const session of summary.value.sessions){
  const key=JSON.stringify([session.hostId??null,session.sessionId??null,session.agentId??null,session.child??null]);
  if(!sessions.has(key))sessions.set(key,session);
 }
 return sessions;
});
const projects=computed(()=>{
 const worked=new Set<string>();
 for(const i of dayIntervals.value){
  if(i.state!=='grouped'&&i.state!=='human')continue;
  const session=i.state==='grouped'?firstSessionByEvidence.value.get(JSON.stringify([i.hostId??null,i.sessionId??null,i.agentId??null,i.child??null])):undefined;
  const name=session?projectName(session):i.workspaceId?projectFromWorkspace(i.workspaceId):'Unassigned';
  if(name!==unassignedProject)worked.add(name);
 }
 return [...worked].sort();
});
const allSessions=computed(()=>summary.value.sessions.map(s=>{
 const key=sessionIntervalKey(s),grouped=daySessionIntervals.value.grouped.get(key)||[],running=daySessionIntervals.value.running.get(key)||[];
 return {...s,seconds:minuteCreditSeconds(grouped.map(i=>[i.start,i.end])),observedSeconds:unionSeconds(running.map(i=>[i.start,i.end]))};
}).filter(s=>project.value==='all'||projectName(s)===project.value).sort((a,b)=>b.seconds-a.seconds||b.lastObservedAt-a.lastObservedAt));
const sessions=computed(()=>allSessions.value.filter(s=>!search.value||[s.title,projectLabel(projectName(s)),projectName(s),s.runId,s.provider].join(' ').toLowerCase().includes(search.value.toLowerCase())));
const visibleSessions=computed(()=>sessions.value.filter(s=>s.seconds>0));
const creditedSessions=computed(()=>allSessions.value.filter(s=>s.seconds>0));
const timelineEligible=computed(()=>{
 const activeChildren=new Set(sessions.value.filter(s=>s.child&&s.seconds>0).map(s=>JSON.stringify([s.hostId??null,s.sessionId??null])));
 return sessions.value.filter(s=>s.seconds>0||!s.child&&activeChildren.has(JSON.stringify([s.hostId??null,s.sessionId??null])));
});
const visibleTimelineKeys=computed(()=>new Set(timelineEligible.value.slice(0,timelineLimit.value).map(s=>s.key)));
const humanBySession=computed(()=>humanIntervalsBySession(summary.value.sessions,dayIntervals.value));
const visibleSessionKeys=computed(()=>new Set(creditedSessions.value.map(sessionIntervalKey)));
const filteredIntervals=computed(()=>dayIntervals.value.filter(i=>{
 if(project.value==='all')return true;
 if(i.state==='human')return Boolean(i.workspaceId&&projectFromWorkspace(i.workspaceId)===project.value);
 return visibleSessionKeys.value.has(intervalSessionKey(i));
}));
const agentTime=computed(()=>creditedSessions.value.filter(s=>!s.child).reduce((sum,s)=>sum+s.seconds,0));
const agentOverlap=computed(()=>{
 const grouped=filteredIntervals.value.filter(interval=>interval.state==='grouped'&&!interval.child);
 const roots=grouped.length?grouped:filteredIntervals.value.filter(interval=>(interval.state==='running'||interval.state==='turn')&&!interval.child);
 const steps=agentLoadSegments(roots,[]).filter(step=>step.end>dayStart.value&&step.start<dayEnd.value);
 return {steps,seconds:steps.filter(step=>step.roots>1).reduce((total,step)=>total+Math.min(step.end,dayEnd.value)-Math.max(step.start,dayStart.value),0),peak:Math.max(0,...steps.map(step=>step.roots))};
});
const humanTime=computed(()=>minuteCreditSeconds(filteredIntervals.value.filter(i=>i.state==='human').map(i=>[i.start,i.end])));
const humanTabs=computed(()=>{
 const groups=new Map<string,{workspaceId:string;tabId:string;title:string;seconds:number;intervals:Array<[number,number]>}>();
 for(const i of filteredIntervals.value.filter(i=>i.state==='human'&&i.workspaceId&&i.tabId)){
  const key=i.workspaceId+':'+i.tabId,group=groups.get(key)||{workspaceId:i.workspaceId!,tabId:i.tabId!,title:i.tabTitle||'Orca tab',seconds:0,intervals:[]};
  group.title=i.tabTitle||group.title;group.intervals.push([i.start,i.end]);groups.set(key,group);
 }
 return [...groups.values()].map(g=>({...g,seconds:minuteCreditSeconds(g.intervals)})).sort((a,b)=>b.seconds-a.seconds);
});
const websites=computed(()=>{
 const groups=new Map<string,{domain:string;project:string;seconds:number;intervals:Array<[number,number]>;browsers:Set<string>;pages:Map<string,{url:string;title:string;seconds:number;intervals:Array<[number,number]>}>}>();
 for(const i of filteredIntervals.value.filter(i=>i.state==='human'&&i.browserDomain)){
  const origin=i.browserOrigin?new URL(i.browserOrigin):undefined;
  const domain=origin&&['localhost','127.0.0.1','::1'].includes(origin.hostname)||origin?.hostname.endsWith('.localhost')?origin.host:i.browserDomain!;
  const siteProject=i.workspaceId?projectFromWorkspace(i.workspaceId):'Unassigned';
  const key=domain+'::'+siteProject,group=groups.get(key)||{domain,project:siteProject,seconds:0,intervals:[] as Array<[number,number]>,browsers:new Set<string>(),pages:new Map<string,{url:string;title:string;seconds:number;intervals:Array<[number,number]>}>()};
  group.intervals.push([i.start,i.end]);if(i.browserBundleId)group.browsers.add(status.value?.sources.find(source=>source.bundleId===i.browserBundleId)?.name||i.browserBundleId);
  if(i.browserUrl){const page=group.pages.get(i.browserUrl)||{url:i.browserUrl,title:i.browserTitle||domain,seconds:0,intervals:[] as Array<[number,number]>};page.title=i.browserTitle||page.title;page.intervals.push([i.start,i.end]);group.pages.set(i.browserUrl,page);}
  groups.set(key,group);
 }
 return [...groups.values()].map(g=>({...g,seconds:minuteCreditSeconds(g.intervals),pages:[...g.pages.values()].map(page=>({...page,seconds:minuteCreditSeconds(page.intervals)})).sort((a,b)=>b.seconds-a.seconds)})).sort((a,b)=>b.seconds-a.seconds);
});
const humanUnassigned=computed(()=>{
 if(project.value!=='all')return 0;
 const assigned=new Map<string,Array<[number,number]>>();
 for(const interval of [...humanBySession.value.values()].flat()){
  const key=interval.sourceEventIds.join(':'),ranges=assigned.get(key)||[];ranges.push([interval.start,interval.end]);assigned.set(key,ranges);
 }
 const remaining=filteredIntervals.value.filter(i=>i.state==='human'&&!i.tabId&&!i.browserDomain).flatMap(i=>{
  let ranges:Array<[number,number]>=[[i.start,i.end]];
  for(const [from,to] of assigned.get(i.sourceEventIds.join(':'))||[])ranges=ranges.flatMap(([start,end]):Array<[number,number]>=>from>=end||to<=start?[[start,end]]:([[start,Math.min(from,end)],[Math.max(to,start),end]] as Array<[number,number]>).filter(([a,b])=>b>a));
  return ranges;
 });
 return minuteCreditSeconds(remaining);
});
const elapsedTime=computed(()=>minuteCreditSeconds(filteredIntervals.value.filter(i=>i.state==='grouped'||i.state==='human').map(i=>[i.start,i.end])));
const runningCount=computed(()=>creditedSessions.value.filter(s=>['working','running'].includes(s.state)&&now.value-s.lastObservedAt<20).length);
const runs=computed(()=>[...new Set(creditedSessions.value.map(s=>s.runId).filter(Boolean))].length);
const timelineProjects=computed(()=>{
 return groupTimelineProjects(timelineEligible.value,filteredIntervals.value.filter(i=>i.state==='human'),humanBySession.value,bars,projectName,projectFromWorkspace,!search.value.trim()).map(project=>({...project,sessions:project.sessions.sort((a,b)=>{
  if(a.runId!==b.runId)return (a.runId||'').localeCompare(b.runId||'');
  if(a.sessionId===b.sessionId&&a.child!==b.child)return a.child?1:-1;
  return (a.sessionId||a.key).localeCompare(b.sessionId||b.key)||(a.child?1:0)-(b.child?1:0);
 })}));
});
const issues=computed(()=>[...new Set([...summary.value.coverage,...summary.value.unresolved].map(i=>i.reason))]);
const dayCaptureIssues=computed(()=>dailyCaptureIssues(summary.value,dayStart.value,dayEnd.value));
const dayCaptureReasons=computed(()=>[...new Set(dayCaptureIssues.value.map(issue=>issue.reason))]);
const confidence=computed(()=>dayConfidence(summary.value,captureHealth.value?.sources||[],status.value?.sources.filter(source=>source.kind==='agent').map(source=>source.id)||[],dayStart.value,dayEnd.value,isToday.value));
const observedAgentSources=computed(()=>confidence.value.sources.filter(source=>source.observed&&status.value?.sources.some(item=>item.kind==='agent'&&item.id===source.id)).length);
const reviewGroups=computed(()=>groupHumanReview(dayIntervals.value));
const exportReviewGroups=computed(()=>groupHumanReview(filteredIntervals.value));
const exportReviewNeeds=computed(()=>exportReviewGroups.value.filter(group=>!group.projectPath&&!group.userAttribution));
const exportReviewConflicts=computed(()=>exportReviewGroups.value.filter(group=>group.attributionSource==='conflict'&&!group.userAttribution));
const reviewNeeds=computed(()=>reviewGroups.value.filter(group=>!group.projectPath&&!group.userAttribution));
const reviewConflicts=computed(()=>reviewGroups.value.filter(group=>group.attributionSource==='conflict'&&!group.userAttribution));
const reviewMinutes=computed(()=>reviewNeeds.value.reduce((total,group)=>total+group.seconds,0));
const dayGaps=computed(()=>unobservedGaps(dayIntervals.value));
const gapSources=computed(()=>[...new Set(dayIntervals.value.filter(interval=>interval.state==='human'||interval.state==='grouped').map(interval=>interval.state==='human'?'Mac activity':status.value?.sources.find(source=>source.id===interval.provider)?.name||interval.provider||'Agent activity'))].join(', '));
const captureAttention=computed(()=>['repair-needed','failed','stale','permission-limited'].flatMap(state=>captureHealth.value?.sources.filter(source=>source.state===state)||[])[0]);
const captureLabel=computed(()=>!status.value?'Checking capture…':!status.value.running?'Capture paused':captureAttention.value?.state==='repair-needed'?`${captureAttention.value.name}: repair hooks`:captureAttention.value?.state==='permission-limited'?`${captureAttention.value.name}: limited detail`:captureAttention.value?`${captureAttention.value.name}: ${captureAttention.value.state}`:captureHealth.value?.sources.some(source=>source.state==='receiving')?'Receiving activity':'Waiting for activity');
function repairCapture(){if(captureAttention.value?.action==='repair-hooks')relaunchHookSetup();else navigate('health');}
const exportOpen=ref(false);
const noteAnchor=ref<{start:number;end:number;label:string}|null>(null),noteText=ref(''),noteProject=ref(''),noteSaving=ref(false),noteError=ref(''),noteSaved=ref(''),notesRevision=ref(0);
const reviewNotes=ref<ManualNote[]>([]);
async function loadReviewNotes(){const date=selectedDate.value;try{const result=await manualNoteTransport.list(date);if(date===selectedDate.value)reviewNotes.value=result;}catch{/* Notes remain available from their own review panel. */}}
watch(selectedDate,()=>{reviewNotes.value=[];void loadReviewNotes();},{immediate:true});
function startNote(start:number,end:number,label:string){noteAnchor.value={start,end,label};noteText.value='';noteProject.value='';noteError.value='';}
async function saveNote(){if(!noteAnchor.value||!noteText.value.trim())return;noteSaving.value=true;noteError.value='';try{const saved=await manualNoteTransport.add({start:noteAnchor.value.start,end:noteAnchor.value.end,project:noteProject.value,note:noteText.value.trim()});reviewNotes.value=[...reviewNotes.value,saved];notesRevision.value++;noteSaved.value=`Note saved for ${noteAnchor.value.label}. This time is not added to observed totals.`;noteAnchor.value=null;}catch(cause){noteError.value=String(cause);}finally{noteSaving.value=false;}}
const timelineRange=computed(()=>clampTimeRange(viewport.value||initialTimelineRange(dayStart.value,dayEnd.value,filteredIntervals.value,now.value,isToday.value),dayStart.value,dayEnd.value));
const ticks=computed(()=>timelineTicks(timelineRange.value).filter(tick=>tick.time>timelineRange.value.start+timelineSpan.value*.025&&tick.time<timelineRange.value.end-timelineSpan.value*.025));
const tickStepLabel=computed(()=>{const step=ticks.value[1]?.time-ticks.value[0]?.time||0;return step<60?`${step}s`:step<3600?`${step/60}m`:`${step/3600}h`;});
const timelineStart=computed(()=>timelineRange.value.start),timelineSpan=computed(()=>timelineRange.value.end-timelineRange.value.start);
const cursorLeft=computed(()=>`${Math.max(0,Math.min(100,(now.value-timelineStart.value)/timelineSpan.value*100))}%`);
const overviewAgents=computed(()=>timelineProjects.value.flatMap(group=>group.creditBars));
const overviewHumans=computed(()=>timelineProjects.value.flatMap(group=>group.humanBars));
const overviewStyle=(i:Pick<Interval,'start'|'end'>)=>({left:`${(i.start-dayStart.value)/(dayEnd.value-dayStart.value)*100}%`,width:`${(i.end-i.start)/(dayEnd.value-dayStart.value)*100}%`});
const overviewSelectionStyle=computed(()=>({left:`${(timelineStart.value-dayStart.value)/(dayEnd.value-dayStart.value)*100}%`,width:`${timelineSpan.value/(dayEnd.value-dayStart.value)*100}%`}));
function setViewport(range:TimeRange){viewport.value=clampTimeRange(range,dayStart.value,dayEnd.value);hoveredLoad.value=null;}
function usePreset(seconds:number){
 if(seconds>=dayEnd.value-dayStart.value){setViewport({start:dayStart.value,end:dayEnd.value});return;}
 const focus=viewport.value?(timelineStart.value+timelineSpan.value/2):isToday.value?now.value:filteredIntervals.value.at(-1)?.end??dayStart.value+12*3600;
 setViewport({start:focus-seconds/2,end:focus+seconds/2});
}
function onTimelineWheel(event:WheelEvent){
 const track=(event.target as Element).closest('.timeline-track, .hour-labels');
 if(!track)return;
 event.preventDefault();
 const bounds=track.getBoundingClientRect();
 if(!bounds.width)return;
 const fraction=Math.max(0,Math.min(1,(event.clientX-bounds.left)/bounds.width));
 if(Math.abs(event.deltaX)>Math.abs(event.deltaY)){
  setViewport(panTimeRange(timelineRange.value,event.deltaX/bounds.width*timelineSpan.value,dayStart.value,dayEnd.value));
  return;
 }
 const delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?bounds.height:1);
 setViewport(zoomTimeRange(timelineRange.value,timelineStart.value+fraction*timelineSpan.value,Math.exp(Math.max(-300,Math.min(300,delta))*.003),dayStart.value,dayEnd.value));
}
let pinch:{range:TimeRange;anchor:number}|null=null;
function onGestureStart(event:Event){
 const track=(event.target as Element).closest('.timeline-track, .hour-labels');
 if(!track)return;
 event.preventDefault();
 const bounds=track.getBoundingClientRect(),clientX=(event as Event&{clientX?:number}).clientX;
 const fraction=clientX===undefined?.5:Math.max(0,Math.min(1,(clientX-bounds.left)/bounds.width));
 pinch={range:{...timelineRange.value},anchor:timelineStart.value+fraction*timelineSpan.value};
}
function onGestureChange(event:Event){
 if(!pinch)return;
 event.preventDefault();
 const scale=(event as Event&{scale?:number}).scale;
 if(scale&&scale>0)setViewport(zoomTimeRange(pinch.range,pinch.anchor,1/scale,dayStart.value,dayEnd.value));
}
function onGestureEnd(){pinch=null;}
let overviewDrag:{action:'start'|'end'|'move';x:number;range:TimeRange;width:number}|null=null;
function onOverviewDown(event:PointerEvent){
 if(event.button!==0)return;
 const track=event.currentTarget as HTMLElement,bounds=track.getBoundingClientRect();
 const action=(event.target as Element).closest<HTMLElement>('[data-range-action]')?.dataset.rangeAction;
 if(!action){const center=dayStart.value+(event.clientX-bounds.left)/bounds.width*(dayEnd.value-dayStart.value);setViewport({start:center-timelineSpan.value/2,end:center+timelineSpan.value/2});return;}
 overviewDrag={action:action as 'start'|'end'|'move',x:event.clientX,range:{...timelineRange.value},width:bounds.width};
 track.setPointerCapture(event.pointerId);event.preventDefault();
}
function onOverviewMove(event:PointerEvent){
 const drag=overviewDrag;if(!drag)return;
 const seconds=(event.clientX-drag.x)/drag.width*(dayEnd.value-dayStart.value);
 if(drag.action==='move')setViewport(panTimeRange(drag.range,seconds,dayStart.value,dayEnd.value));
 else if(drag.action==='start')setViewport({start:Math.max(dayStart.value,Math.min(drag.range.end-minimumTimelineSpan,drag.range.start+seconds)),end:drag.range.end});
 else setViewport({start:drag.range.start,end:Math.min(dayEnd.value,Math.max(drag.range.start+minimumTimelineSpan,drag.range.end+seconds))});
}
function onOverviewUp(){overviewDrag=null;}
function onHandleKey(event:KeyboardEvent,side:'start'|'end'){
 if(event.key!=='ArrowLeft'&&event.key!=='ArrowRight')return;
 event.preventDefault();const delta=(event.key==='ArrowRight'?1:-1)*(event.shiftKey?5:1)*(timelineSpan.value<=5*60?10:60);
 const range=timelineRange.value;
 if(side==='start')setViewport({start:Math.max(dayStart.value,Math.min(range.end-minimumTimelineSpan,range.start+delta)),end:range.end});
 else setViewport({start:range.start,end:Math.min(dayEnd.value,Math.max(range.start+minimumTimelineSpan,range.end+delta))});
}
const bars=(s:Session)=>daySessionIntervals.value.grouped.get(sessionIntervalKey(s))||[];
const creditedBars=(s:Session)=>creditedIntervals(bars(s));
const childrenOf=(s:Session,group:Session[])=>group.filter(child=>child.child&&child.hostId===s.hostId&&child.sessionId===s.sessionId);
const parentOf=(s:Session,group:Session[])=>group.find(parent=>!parent.child&&parent.hostId===s.hostId&&parent.sessionId===s.sessionId);
const rowVisible=(s:Session,group:Session[])=>!s.child||!parentOf(s,group)||expandedRoots.value[parentOf(s,group)!.key]===true;
const barStyle=(i:Pick<Interval,'start'|'end'>)=>{
 const start=Math.max(i.start,timelineStart.value),end=Math.min(i.end,timelineStart.value+timelineSpan.value);
 return {left:`${Math.max(0,(start-timelineStart.value)/timelineSpan.value*100)}%`,width:`${Math.max(0,(end-start)/timelineSpan.value*100)}%`};
};
const workloadPath=(group:TimelineProjectGroup)=>workloadAreaPath(group.load,timelineStart.value,timelineSpan.value);
function moveWorkloadHover(event:PointerEvent,group:TimelineProjectGroup){
 const bounds=(event.currentTarget as HTMLElement).getBoundingClientRect();
 const left=Math.max(0,Math.min(bounds.width,event.clientX-bounds.left));
 const time=timelineStart.value+left/bounds.width*timelineSpan.value;
 const load=group.load.find(segment=>segment.start<=time&&time<segment.end);
 hoveredLoad.value={project:group.name,left,tooltipLeft:bounds.width<236?bounds.width/2:Math.max(118,Math.min(bounds.width-118,left)),time,roots:load?.roots||0,children:load?.children||0,credited:group.creditBars.some(interval=>interval.start<=time&&time<interval.end),human:group.humanBars.some(interval=>interval.start<=time&&time<interval.end)};
}
const orcaPollNote=computed(()=>!status.value?'Checking capture…':!status.value.surfaces.orcaPolling?'Orca polling off':!status.value.orcaAvailable?'Orca not installed · optional':status.value.lastPoll?`Last Orca poll ${new Date(status.value.lastPoll*1000).toLocaleTimeString('en',{hour:'2-digit',minute:'2-digit',hour12:false})}`:'Waiting for Orca poll');
let timer:ReturnType<typeof setInterval>|undefined,clockTimer:ReturnType<typeof setInterval>|undefined,dayReviewTimer:ReturnType<typeof setInterval>|undefined;
let unlistenNavigation:(()=>void)|undefined;
let unlistenDeepLink:(()=>void)|undefined;
let unmounted=false;
type Page='today'|'sessions'|'health'|'usage'|'settings';
function navigate(destination:Page,nextProject='all'){
 if(page.value==='today'){const top=document.querySelector<HTMLElement>('.day-content')?.scrollTop||0;sessionStorage.setItem(`agent-time.day-scroll:${selectedDate.value}`,String(top));}
 page.value=destination;project.value=nextProject;selected.value=null;
 if(destination==='today'&&nextProject!=='all')reviewSiteFilter.value='';
 if(destination==='today')view.value='timeline';
 if(destination==='sessions')view.value='sessions';
 if(destination==='today')void nextTick().then(()=>{const pane=document.querySelector<HTMLElement>('.day-content');if(pane)pane.scrollTop=Number(sessionStorage.getItem(`agent-time.day-scroll:${selectedDate.value}`)||0);});
}
async function reviewSite(key:string){selectedDate.value=dateString(new Date());navigate('today');reviewSiteFilter.value=key;await nextTick();document.getElementById('human-review')?.scrollIntoView({behavior:'smooth',block:'start'});}
function scrollReview(){document.getElementById('human-review')?.scrollIntoView({behavior:'smooth',block:'start'});}
function applyReviewedSummary(next:Summary){refreshRevision++;reviewRevision.value++;summary.value=next;void loadDayReview();}
async function listenNavigation(){if(native){const {listen}=await import('@tauri-apps/api/event');const dispose=await listen<string>('navigate',event=>{if(event.payload==='hook-setup'){navigate('health');relaunchHookSetup();}else if(event.payload==='settings'||event.payload==='today'||event.payload==='usage'||event.payload==='health')navigate(event.payload);});if(unmounted)dispose();else unlistenNavigation=dispose;}}
function handleDeepLink(urls:string[]){for(const raw of urls){try{const url=new URL(raw);if(url.protocol!=='agenttime:'||url.pathname!=='/'||url.search||url.hash)continue;if(url.hostname==='capture-health')navigate('health');else if(url.hostname==='today')navigate('today');}catch{/* Ignore malformed external URLs. */}}}
async function listenDeepLinks(){if(!native)return;const {getCurrent,onOpenUrl}=await import('@tauri-apps/plugin-deep-link');const dispose=await onOpenUrl(handleDeepLink);if(unmounted)dispose();else unlistenDeepLink=dispose;handleDeepLink(await getCurrent()||[]);}
function refresh():Promise<void>{
 if(refreshJob)return refreshJob;const revision=refreshRevision;
 const date=selectedDate.value;
 refreshJob=(async()=>{try{const [s,meta,health]=await Promise.all([transport.summary(date),transport.status(),transport.captureHealth()]);if(unmounted||revision!==refreshRevision||date!==selectedDate.value)return;summary.value=s;status.value=meta;captureHealth.value=health;error.value='';}catch(e){if(!unmounted&&revision===refreshRevision)error.value=String(e);}})().finally(()=>{refreshJob=undefined;});return refreshJob;
}
watch(selectedDate,()=>{viewport.value=null;dayReview.value=null;void loadDayReview();refreshRevision++;const pending=refreshJob;if(pending)void pending.then(()=>refresh());else void refresh();});
async function toggleCapture(){captureBusy.value=true;refreshRevision++;try{status.value=status.value?.running?await transport.stop():await transport.start();error.value='';}catch(e){error.value=String(e);}finally{captureBusy.value=false;void refresh();}}
async function updateSettings(settings:Partial<CaptureSettings>){settingsBusy.value=true;refreshRevision++;try{status.value=await transport.settings(settings);error.value='';}catch(e){error.value=String(e);}finally{settingsBusy.value=false;void refresh();}}
function changeDay(amount:number){const date=new Date(selectedDate.value+'T12:00:00');date.setDate(date.getDate()+amount);selectedDate.value=dateString(date);selected.value=null;timelineLimit.value=40;tableLimit.value=100;}
function exportCsv(){
 exportOpen.value=false;
 const headers=['Project','Activity','Run','Task','Agent seconds','Observed tool seconds','State','Proof','Human seconds','Source'];
 const humanProjects=new Map<string,Array<[number,number]>>();
 for(const interval of filteredIntervals.value.filter(i=>i.state==='human')){
  const session=interval.sessionId?summary.value.sessions.find(s=>s.sessionId===interval.sessionId&&s.hostId===interval.hostId):undefined;
  const name=interval.workspaceId?projectFromWorkspace(interval.workspaceId):session?projectName(session):'Unassigned';
  const ranges=humanProjects.get(name)||[];ranges.push([interval.start,interval.end]);humanProjects.set(name,ranges);
 }
 const rows=[
  ...creditedSessions.value.map(s=>[projectName(s),s.title,s.runId||'',s.taskId||'',String(Math.round(s.seconds)),String(Math.round(s.observedSeconds)),s.state,s.proof,'0','Agent session']),
  ...[...humanProjects].map(([name,ranges])=>[name,'Human activity','','','0','0','','estimated',String(minuteCreditSeconds(ranges)),'Foreground activity']),
 ];
 const csv=[headers,...rows].map(row=>row.map(v=>'"'+(/^[=+\-@]/.test(v)?"'"+v:v).replaceAll('"','""')+'"').join(',')).join('\r\n');
 const url=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));const a=document.createElement('a');a.href=url;a.download=`agent-time-${project.value==='all'?'all-projects':project.value.replace(/[^a-zA-Z0-9_-]/g,'-')}-${selectedDate.value}.csv`;a.click();URL.revokeObjectURL(url);
}
function openSettings(e:KeyboardEvent){if(e.key==='Escape'&&noteAnchor.value){noteAnchor.value=null;e.preventDefault();return;}if(e.key==='Escape'&&exportOpen.value){exportOpen.value=false;e.preventDefault();return;}if((e.metaKey||e.ctrlKey)&&e.key===','){e.preventDefault();navigate('settings');}else if(e.key==='Escape'&&selected.value){selected.value=null;}}
onMounted(()=>{void listenNavigation();void listenDeepLinks();void refresh();void loadDayReview();timer=setInterval(()=>{void refresh();},5000);dayReviewTimer=setInterval(()=>{void loadDayReview();},60000);let previousDay=dateString(new Date());clockTimer=setInterval(()=>{now.value=Date.now()/1000;const currentDay=dateString(new Date());if(currentDay!==previousDay){if(selectedDate.value===previousDay)selectedDate.value=currentDay;previousDay=currentDay;}},1000);window.addEventListener('keydown',openSettings);});
onUnmounted(()=>{unmounted=true;unlistenNavigation?.();unlistenDeepLink?.();clearInterval(timer);clearInterval(dayReviewTimer);clearInterval(clockTimer);window.removeEventListener('keydown',openSettings);});
</script>
<template>
<TooltipProvider :delay-duration="350">
<HookSetup mode="onboarding" @status="hookStatus=$event"/>
<div class="app-shell">
 <aside class="sidebar">
  <div class="titlebar-space" data-tauri-drag-region></div>
  <div class="brand"><div class="brand-mark"><Clock3 :size="19"/></div><span>Agent Time</span><span class="version">Preview</span></div>
  <div class="sidebar-section"><button :class="['nav-row',{active:page==='today'}]" @click="navigate('today')"><CalendarDays :size="17"/><span>My day</span></button><button :class="['nav-row',{active:page==='sessions'}]" @click="navigate('sessions')"><Layers3 :size="17"/><span>Agent sessions</span><span class="nav-count">{{creditedSessions.length}}</span></button><button :class="['nav-row',{active:page==='health'}]" @click="navigate('health')"><Activity :size="17"/><span>Capture health</span><span v-if="issues.length" class="issue-dot"></span></button><button :class="['nav-row',{active:page==='usage'}]" @click="navigate('usage')"><Bot :size="17"/><span>Tokens &amp; limits</span></button><button :class="['nav-row',{active:page==='settings'}]" @click="navigate('settings')"><Settings2 :size="17"/><span>Settings</span></button></div>
  <div class="section-label">Projects <span>{{projects.length}}</span></div>
  <button :class="['project-row',{selected:project==='all'&&(page==='today'||page==='sessions')}]" @click="navigate('today')"><Folder :size="16"/><span>All projects</span></button>
  <div class="project-list"><button v-for="(name,index) in projects" :key="name" :class="['project-row',{selected:project===name&&(page==='today'||page==='sessions')}]" @click="navigate('today',name)"><span class="project-dot" :style="{background:palette[index%palette.length]}"></span><span :title="name">{{projectDisplay(name,projects)}}</span><ChevronRight :size="12"/></button><p v-if="!projects.length" class="sidebar-empty">Projects appear when activity is captured.</p></div>
  <div class="sidebar-footer"><button class="collector-line capture-status-link" @click="captureAttention?repairCapture():navigate('health')"><span :class="['status-dot',{live:status?.running&&!captureAttention}]"></span><span>{{captureLabel}}</span></button><div class="footer-line"><span>Stored on this Mac</span><button class="icon-button" aria-label="Settings" @click="navigate('settings')"><Settings2 :size="15"/></button></div></div>
 </aside>
 <main class="main-pane">
  <header class="toolbar" data-tauri-drag-region><div class="breadcrumbs"><template v-if="page==='today'||page==='sessions'"><span>{{project==='all'?'All projects':projectDisplay(project,projects)}}</span><ChevronRight :size="12"/></template><strong>{{page==='usage'?'Tokens & limits':page==='settings'?'Settings':page==='health'?'Capture health':page==='sessions'?'Agent sessions':'My day'}}</strong></div><div class="toolbar-actions"><TooltipRoot v-if="page==='today'||page==='sessions'"><TooltipTrigger as-child><button class="icon-button" aria-label="Review selected day before exporting CSV" @click="exportOpen=true"><Download :size="17"/></button></TooltipTrigger><TooltipPortal><TooltipContent class="tooltip">Review this day before export</TooltipContent></TooltipPortal></TooltipRoot><button class="capture-button" :disabled="busy||!status" @click="toggleCapture"><Pause v-if="status?.running" :size="12"/><Play v-else :size="12"/>{{!status?'Checking…':settingsBusy?'Saving…':captureBusy?'Updating capture…':status.running?'Pause capture':'Start capture'}}</button></div></header>
  <div v-if="error||status?.lastError" class="error-banner"><CircleHelp :size="16"/><span>{{error||status?.lastError}}</span><button @click="refresh">Retry</button></div>
  <div v-if="outdatedHooks.length" class="error-banner" role="alert"><CircleHelp :size="16"/><span><strong>Agent tracking may be idle.</strong> {{outdatedAgents}} {{outdatedHooks.length===1?'hook needs':'hooks need'}} updating. Time from affected sessions may be missing.</span><button @click="relaunchHookSetup">Update hooks</button></div>
  <div v-if="sourceProblems.length" class="error-banner" role="alert"><CircleHelp :size="16"/><span><strong>Capture needs attention.</strong> {{sourceProblemNames}} {{sourceProblems.length===1?'has':'have'}} no recent observations.</span><button @click="navigate('health')">Capture health</button></div>
  <BetaUpdates v-if="betaUpdatesEnabled"/>
  <UsagePage v-if="page==='usage'" :status="status"/>
  <CaptureSettingsPage v-else-if="page==='settings'" :status="status" :busy="busy" @change="updateSettings" @error="error=$event"/>
  <section v-else-if="page!=='health'" class="day-content">
   <div class="day-heading"><div><h1>{{page==='sessions'?'Agent sessions':fullDate}}</h1><p>{{page==='sessions'?'Independent sessions, grouped by project and orchestration run.': 'A clear view of your work, and the agents working alongside you.'}}</p></div><div class="date-controls"><button class="icon-button" aria-label="Previous day" @click="changeDay(-1)"><ChevronLeft :size="16"/></button><input type="date" aria-label="Choose day" v-model="selectedDate"/><button class="icon-button" aria-label="Next day" @click="changeDay(1)"><ChevronRight :size="16"/></button><button class="today-button" @click="selectedDate=dateString(new Date())">Today</button></div></div>
   <SetupVerification v-if="page==='today'&&isToday" :status="status" :hooks="hookStatus" :health="captureHealth" :busy="busy" @health="navigate('health')" @settings="navigate('settings')" @hooks="relaunchHookSetup" @start="toggleCapture"/>
   <div v-if="page==='today'&&project==='all'" class="review-priority"><div><strong>{{dayReview?.completedAt&&!dayReview.stale?'Day reviewed':dayReview?.stale?'Review needs another look':'Needs review'}}</strong><span>{{duration(reviewMinutes)}} unmatched · {{reviewConflicts.length}} conflicting {{reviewConflicts.length===1?'group':'groups'}} · {{dayGaps.length}} observation {{dayGaps.length===1?'gap':'gaps'}}</span><small v-if="dayReview?.completedAt&&!dayReview.stale">Marked reviewed {{new Date(dayReview.completedAt*1000).toLocaleString()}}. New capture or attribution changes reopen the day.</small></div><button @click="scrollReview">Review activity</button><button v-if="dayReview?.hasActivity&&(!dayReview.completedAt||dayReview.stale)" :disabled="dayReviewBusy" @click="markDayReviewed">{{reviewNeeds.length||reviewConflicts.length||dayGaps.length?'Mark reviewed with remaining items':'Mark day reviewed'}}</button></div>
   <div v-if="page==='today'&&project==='all'&&dayReview?.backlog.length" class="review-backlog"><strong>Earlier days to review</strong><button v-for="item in dayReview.backlog" :key="item.date" @click="selectedDate=item.date">{{item.date}} · {{duration(item.unmatchedSeconds)}} unmatched · {{item.conflicts}} conflicts · {{item.gaps}} gaps</button></div>
   <p v-if="page==='today'&&dayReviewError" class="error-banner" role="alert">{{dayReviewError}}</p>
   <details v-if="page==='today'&&project==='all'&&confidence.sources.length" class="day-confidence"><summary><ShieldCheck :size="14"/><strong>Capture confidence</strong><span>{{confidence.observed}} source{{confidence.observed===1?'':'s'}} with credited activity<span v-if="confidence.attention"> · {{confidence.attention}} need{{confidence.attention===1?'s':''}} repair</span><span v-if="confidence.caveats"> · {{confidence.caveats}} caveat{{confidence.caveats===1?'':'s'}}</span></span></summary><div class="confidence-sources"><div v-for="source in confidence.sources" :key="source.id"><strong>{{source.name}}</strong><span :class="source.state">{{source.detail}}</span><button v-if="source.action==='repair-hooks'" @click="relaunchHookSetup">Repair hooks</button><button v-else-if="source.action!=='none'&&source.state==='attention'" @click="navigate('health')">Review capture</button></div><p>Past days show recorded evidence only. A configured hook does not confirm event delivery.</p></div></details>
   <div class="metrics-strip"><div class="metric"><span><Monitor :size="14"/>Mac activity <span class="estimate">Estimated</span></span><strong>{{duration(humanTime)}}</strong><span class="metric-confidence">{{confidence.sources.find(source=>source.id==='macos')?.state||'unknown'}} source</span><small>{{project==='all'?'Active foreground time across apps':'Attributed activity in this project'}}</small></div><div class="metric"><span><Bot :size="14"/>Agent time</span><strong>{{duration(agentTime)}}</strong><span class="metric-confidence">{{observedAgentSources}} agent sources observed</span><small>Grouped activity, one-minute minimum</small></div><div class="metric"><span><Clock3 :size="14"/>Elapsed activity</span><strong>{{duration(elapsedTime)}}</strong><span class="metric-confidence"><span v-if="isToday">{{confidence.attention}} need repair · </span>{{confidence.caveats}} caveats</span><small>Overlapping activity counted once</small></div><div class="metric compact"><span><Radio :size="14"/>Working now</span><strong>{{runningCount}}<span> agents</span></strong><small>{{runs}} orchestration {{runs===1?'run':'runs'}}</small></div></div>
   <details v-if="page==='today'&&agentOverlap.steps.length" class="overlap-explainer"><summary>How simultaneous agents affect totals <span>{{duration(agentOverlap.seconds)}} of observed agent overlap · peak {{agentOverlap.peak}} at once</span></summary><div class="overlap-track" role="img" :aria-label="`Agent activity across this day; ${duration(agentOverlap.seconds)} had multiple root agents active`"><span v-for="step in agentOverlap.steps" :key="`${step.start}:${step.end}`" :class="{multiple:step.roots>1}" :style="{left:`${Math.max(0,(step.start-dayStart)/(dayEnd-dayStart)*100)}%`,width:`${Math.min(step.end,dayEnd)-Math.max(step.start,dayStart)>(0)?(Math.min(step.end,dayEnd)-Math.max(step.start,dayStart))/(dayEnd-dayStart)*100:0}%`}" :title="`${clock(step.start)}–${clock(step.end)} · ${step.roots} root agents`"></span></div><p><strong>Agent time</strong> adds each session’s credited work. <strong>Elapsed activity</strong> counts shared wall time once, including Mac activity. Darker bars show multiple root agents active together. The overlap strip uses observed spans; totals apply the one-minute minimum.</p></details>
   <details v-if="dayCaptureIssues.length" class="day-capture-issues"><summary><CircleHelp :size="14"/><span>{{dayCaptureIssues.length}} capture {{dayCaptureIssues.length===1?'caveat':'caveats'}} on this day. Totals include only credited observations.</span><span class="issue-expand">Details</span></summary><ul><li v-for="reason in dayCaptureReasons" :key="reason">{{reason}}</li></ul><button @click="navigate('health')">Open capture health</button></details>
   <details v-if="humanTabs.length||websites.length||humanUnassigned" class="human-tabs"><summary class="human-tabs-summary"><span><strong>Human activity details</strong><small>{{humanTabs.length}} Orca tabs · {{websites.length}} websites</small></span><b>{{duration(humanTime)}}</b></summary><div v-for="tab in humanTabs" :key="tab.workspaceId+tab.tabId" class="human-tab-row"><span><strong>{{tab.title}}</strong><small>Orca · {{projectLabel(projectFromWorkspace(tab.workspaceId))}} · {{tab.workspaceId.split('::').at(-1)?.split('/').at(-1)}}</small></span><b>{{duration(tab.seconds)}}</b></div><details v-for="site in websites" :key="site.domain+'::'+site.project" class="human-site"><summary class="human-tab-row website-row"><span><strong>{{site.domain}}</strong><small>{{[...site.browsers].join(', ')}} · {{site.project==='Unassigned'?'Website':projectLabel(site.project)}} · {{site.pages.length}} pages</small></span><b>{{duration(site.seconds)}}</b></summary><div v-for="sitePage in site.pages" :key="sitePage.url" class="human-tab-row web-page-row"><span><strong>{{sitePage.title}}</strong><small :title="sitePage.url">{{sitePage.url}}</small></span><b>{{duration(sitePage.seconds)}}</b></div></details><div v-if="humanUnassigned" class="human-tab-row"><span><strong>Activity without a site or tab match</strong><small>Includes worktree-attributed Orca time shown on project rows and activity in other apps</small></span><b>{{duration(humanUnassigned)}}</b></div></details>
   <HumanReview v-if="page==='today'&&project==='all'" id="human-review" :date="selectedDate" :intervals="dayIntervals" :notes="reviewNotes" :site-filter="reviewSiteFilter" @changed="applyReviewedSummary" @clear-filter="reviewSiteFilter=''" @note="startNote"/>
   <WeeklyReview v-if="page==='today'&&project==='all'" :date="selectedDate" :revision="reviewRevision"/>
   <WorkOutcomes v-if="page==='today'" :date="selectedDate" :project="project" :groups="timelineProjects"/>
   <ManualNotes v-if="page==='today'&&project==='all'" :date="selectedDate" :intervals="dayIntervals" :revision="notesRevision" @changed="loadReviewNotes"/>
   <p v-if="noteSaved" class="note-saved" role="status">{{noteSaved}} <button @click="noteSaved=''">Dismiss</button></p>
   <section v-if="dayGaps.length&&page==='today'" class="gap-timeline" aria-label="Observation gaps on the day timeline"><div><strong>Observation gaps</strong><small>No credited {{gapSources||'activity'}} during these spans. A gap does not prove idleness.</small></div><div class="gap-track"><button v-for="gap in dayGaps" :key="gap.start" :style="{left:`${(gap.start-dayStart)/(dayEnd-dayStart)*100}%`,width:`${(gap.end-gap.start)/(dayEnd-dayStart)*100}%`}" :title="`${clock(gap.start)}–${clock(gap.end)} · ${duration(gap.seconds)} without credited ${gapSources||'activity'}`" :aria-label="`${duration(gap.seconds)} without credited ${gapSources||'activity'} from ${clock(gap.start)} to ${clock(gap.end)}; add note`" @click="startNote(gap.start,gap.end,'unobserved gap')"></button></div><small>{{dayGaps.length}} gaps of at least 5 minutes · click a gap to note what happened</small><div v-if="reviewNotes.some(note=>dayGaps.some(gap=>note.start===gap.start&&note.end===gap.end))" class="gap-note-list"><p v-for="item in reviewNotes.filter(note=>dayGaps.some(gap=>note.start===gap.start&&note.end===gap.end))" :key="item.id"><strong>{{clock(item.start)}}–{{clock(item.end)}} note:</strong> {{item.note}}</p></div></section>
   <TabsRoot v-model="view" class="activity-panel"><div class="panel-toolbar"><TabsList class="segmented"><TabsTrigger value="timeline"><CalendarDays :size="14"/>Timeline</TabsTrigger><TabsTrigger value="sessions"><Layers3 :size="14"/>Sessions</TabsTrigger></TabsList><div class="search-field"><Search :size="14"/><input v-model="search" aria-label="Search sessions" placeholder="Search sessions…"/></div></div>
    <TabsContent value="timeline" class="timeline" @wheel="onTimelineWheel" @gesturestart="onGestureStart" @gesturechange="onGestureChange" @gestureend="onGestureEnd"><div class="timeline-zoom"><span class="zoom-caption">Day overview <small>{{rangeClock(timelineStart)}}–{{rangeClock(timelineStart+timelineSpan)}} · {{tickStepLabel}} grid · scroll/pinch to zoom</small></span><div class="timeline-overview-track" aria-label="Full-day timeline range" @pointerdown="onOverviewDown" @pointermove="onOverviewMove" @pointerup="onOverviewUp" @pointercancel="onOverviewUp"><span v-for="(interval,index) in overviewAgents" :key="'a'+index" class="overview-bar overview-agent" :style="overviewStyle(interval)"></span><span v-for="(interval,index) in overviewHumans" :key="'h'+index" class="overview-bar overview-human" :style="overviewStyle(interval)"></span><span class="overview-selection" :class="{narrow:timelineSpan<=45*60,atStart:timelineStart===dayStart,atEnd:timelineStart+timelineSpan===dayEnd}" data-range-action="move" :style="overviewSelectionStyle"><span class="overview-handle start" data-range-action="start" role="slider" tabindex="0" aria-label="Visible range start" :aria-valuemin="0" :aria-valuemax="Math.round(timelineRange.end-dayStart-minimumTimelineSpan)" :aria-valuenow="Math.round(timelineRange.start-dayStart)" :aria-valuetext="rangeClock(timelineRange.start)" @keydown="onHandleKey($event,'start')"></span><span class="overview-handle end" data-range-action="end" role="slider" tabindex="0" aria-label="Visible range end" :aria-valuemin="Math.round(timelineRange.start-dayStart+minimumTimelineSpan)" :aria-valuemax="Math.round(dayEnd-dayStart)" :aria-valuenow="Math.round(timelineRange.end-dayStart)" :aria-valuetext="rangeClock(timelineRange.end)" @keydown="onHandleKey($event,'end')"></span></span></div><div class="zoom-presets"><button @click="usePreset(60)">1m</button><button @click="usePreset(900)">15m</button><button @click="usePreset(3600)">1h</button><button @click="usePreset(14400)">4h</button><button @click="usePreset(dayEnd-dayStart)">Full day</button></div></div><div class="timeline-header"><span>Project / agent / activity</span><div class="hour-labels"><span v-for="tick in ticks.filter(tick=>tick.major)" :key="tick.time" :style="{left:`${(tick.time-timelineStart)/timelineSpan*100}%`}">{{tickClock(tick.time)}}</span></div><span class="time-total" title="Agent time and human activity are shown separately">Time</span></div>
     <div v-if="!timelineProjects.length" class="empty-state"><div class="empty-icon"><Clock3 :size="29"/></div><h2>Your work will appear here</h2><p>Start capture to discover your Orca sessions.<br/>Time is recorded as activity is observed.</p><button class="primary-button" :disabled="busy||status?.running" @click="toggleCapture">{{status?.running?'Listening for activity…':'Start capture'}}</button></div>
     <div v-for="(projectGroup,projectIndex) in timelineProjects" :key="projectGroup.name" class="timeline-project"><button class="project-timeline-row" :aria-label="`${projectCollapsed(projectGroup.name)?'Expand':'Collapse'} ${projectGroup.name} project, peak ${projectGroup.peakConcurrent} concurrent agents`" :aria-expanded="!projectCollapsed(projectGroup.name)" @click="collapsedProjects[projectGroup.name]=!projectCollapsed(projectGroup.name)"><span class="project-timeline-label"><ChevronRight :size="13" :class="{expanded:!projectCollapsed(projectGroup.name)}"/><span class="project-symbol"><Folder :size="15"/></span><span><strong :title="projectGroup.name">{{projectDisplay(projectGroup.name,projects)}}</strong><small>{{projectCaption(projectGroup)}}</small></span></span><span class="timeline-track project-workload" @pointermove="moveWorkloadHover($event,projectGroup)" @pointerleave="hoveredLoad=null"><span v-for="tick in ticks" :key="tick.time" class="grid-line" :class="{minor:!tick.major}" :style="{left:`${(tick.time-timelineStart)/timelineSpan*100}%`}"></span><svg v-if="projectGroup.load.length" class="workload-area" :viewBox="`0 0 ${workloadChartWidth} ${workloadChartHeight}`" preserveAspectRatio="none" aria-hidden="true"><path :d="workloadPath(projectGroup)"/></svg><span v-for="(interval,index) in projectGroup.creditBars" :key="'c'+index" class="time-block agent-credit" :style="barStyle(interval)" :title="`${tickClock(interval.start)}–${tickClock(interval.end)} · credited agent time (one-minute minimum)`"></span><span v-for="(interval,index) in projectGroup.humanBars" :key="'h'+index" class="time-block human" :style="barStyle(interval)" :title="`${tickClock(interval.start)}–${tickClock(interval.end)} · credited human time (one-minute minimum)`"></span><span v-if="projectGroup.peakConcurrent" class="workload-scale" aria-hidden="true"><b v-if="projectGroup.peakConcurrent>1">Peak {{projectGroup.peakConcurrent}}</b><small>1 agent</small></span><template v-if="hoveredLoad?.project===projectGroup.name"><span class="workload-crosshair" :style="{left:`${hoveredLoad.left}px`}" aria-hidden="true"></span><span class="workload-tooltip" :class="{below:projectIndex===0}" :style="{left:`${hoveredLoad.tooltipLeft}px`}" role="tooltip"><strong>{{tickClock(hoveredLoad.time)}} · {{hoveredLoad.roots+hoveredLoad.children}} {{hoveredLoad.roots+hoveredLoad.children===1?'agent':'agents'}}</strong><span>{{hoveredLoad.roots}} {{hoveredLoad.roots===1?'observed session':'observed sessions'}} · {{hoveredLoad.children}} {{hoveredLoad.children===1?'subagent':'subagents'}}</span><span>Credited agent time: {{hoveredLoad.credited?'Yes':'No'}}</span><span>Human activity: {{hoveredLoad.human?'Yes':'No'}}</span></span></template></span><span class="time-total"><strong>{{projectGroup.agentSeconds?`${duration(projectGroup.agentSeconds)} agent`:`${duration(projectGroup.humanSeconds)} human`}}</strong><small v-if="projectGroup.agentSeconds&&projectGroup.humanSeconds">{{duration(projectGroup.humanSeconds)}} human</small></span></button>
     <template v-if="!projectCollapsed(projectGroup.name)">
     <div v-for="session in projectGroup.sessions.filter(s=>visibleTimelineKeys.has(s.key))" v-show="rowVisible(session,projectGroup.sessions)" :key="session.key" :class="['timeline-row',{focused:selected?.key===session.key,child:session.child}]" role="button" tabindex="0" :aria-label="`View details for ${session.title}`" @click="selected=session" @keydown.enter="selected=session" @keydown.space.prevent="selected=session"><div class="session-label"><button v-if="!session.child&&childrenOf(session,projectGroup.sessions).length" class="row-toggle" :aria-label="expandedRoots[session.key]?'Collapse subagents':'Expand subagents'" :aria-expanded="expandedRoots[session.key]===true" @click.stop="expandedRoots[session.key]=!expandedRoots[session.key]"><ChevronRight :size="13" :class="{expanded:expandedRoots[session.key]}"/></button><span v-else class="row-toggle-spacer"></span><span class="agent-symbol" :style="{color:'#7958d9',background:'#7958d916'}"><Bot :size="15"/></span><div><strong>{{session.title}}</strong><small>{{session.provider||'Agent'}} <span v-if="session.child">· Subagent</span><span v-else-if="session.runId">· Run {{session.runId.slice(-6)}}</span><span v-else>· Independent</span></small></div></div><div class="timeline-track"><span v-for="tick in ticks" :key="tick.time" class="grid-line" :class="{minor:!tick.major}" :style="{left:`${(tick.time-timelineStart)/timelineSpan*100}%`}"></span><span v-for="(interval,index) in creditedBars(session)" :key="'credit-a'+index" class="time-block agent credit" :style="barStyle(interval)" :title="`${tickClock(interval.start)}–${tickClock(interval.end)} · credited agent time (one-minute minimum)`"></span><span v-for="(interval,index) in bars(session)" :key="'a'+index" class="time-block agent" :style="barStyle(interval)" :title="`${tickClock(interval.start)}–${tickClock(interval.end)} · agent time (gaps up to 1m grouped)`"></span><template v-if="!session.child"><span v-for="(interval,index) in childrenOf(session,projectGroup.sessions).flatMap(child=>creditedBars(child))" :key="'credit-c'+index" class="time-block subagent credit" :style="barStyle(interval)" :title="`${tickClock(interval.start)}–${tickClock(interval.end)} · credited subagent time (one-minute minimum)`"></span><span v-for="(interval,index) in childrenOf(session,projectGroup.sessions).flatMap(child=>bars(child))" :key="'c'+index" class="time-block subagent" :style="barStyle(interval)" :title="`${tickClock(interval.start)}–${tickClock(interval.end)} · subagent`"></span></template></div><span class="time-total"><strong>{{duration(session.seconds)}}</strong></span></div>
     <template v-if="projectGroup.mac.length">
      <button class="timeline-row activity-row activity-heading" :aria-label="`${activityCollapsed(projectGroup.name,'mac')?'Expand':'Collapse'} Mac activity in ${projectGroup.name}`" :aria-expanded="!activityCollapsed(projectGroup.name,'mac')" @click="toggleActivity(projectGroup.name,'mac')"><span class="session-label"><span class="row-toggle"><ChevronRight :size="13" :class="{expanded:!activityCollapsed(projectGroup.name,'mac')}"/></span><span class="agent-symbol activity-symbol"><Monitor :size="15"/></span><span><strong>Mac activity</strong><small>{{projectGroup.macApps.length}} {{projectGroup.macApps.length===1?'app':'apps'}}</small></span></span><span class="timeline-track"><span v-for="tick in ticks" :key="tick.time" class="grid-line" :class="{minor:!tick.major}" :style="{left:`${(tick.time-timelineStart)/timelineSpan*100}%`}"></span><span v-for="(interval,index) in projectGroup.macBars" :key="index" class="time-block human" :style="barStyle(interval)" :title="`${tickClock(interval.start)}–${tickClock(interval.end)} · ${interval.foregroundName||'Mac activity'} · credited human time`"></span></span><span class="time-total"><strong>{{duration(projectGroup.macSeconds)}}</strong></span></button>
      <template v-if="!activityCollapsed(projectGroup.name,'mac')"><div v-for="app in projectGroup.macApps" :key="app.key" class="timeline-row activity-detail-row"><div class="session-label"><span class="row-toggle-spacer"></span><span class="agent-symbol activity-symbol"><Monitor :size="13"/></span><div><strong>{{app.label}}</strong><small>{{app.detail}}</small></div></div><div class="timeline-track"><span v-for="tick in ticks" :key="tick.time" class="grid-line" :class="{minor:!tick.major}" :style="{left:`${(tick.time-timelineStart)/timelineSpan*100}%`}"></span><span v-for="(interval,index) in app.bars" :key="index" class="time-block human" :style="barStyle(interval)" :title="`${tickClock(interval.start)}–${tickClock(interval.end)} · ${app.label}`"></span></div><span class="time-total"><strong>{{duration(app.seconds)}}</strong></span></div></template>
     </template>
     <template v-if="projectGroup.browser.length">
      <button class="timeline-row activity-row activity-heading" :aria-label="`${activityCollapsed(projectGroup.name,'browser')?'Expand':'Collapse'} Browser activity in ${projectGroup.name}`" :aria-expanded="!activityCollapsed(projectGroup.name,'browser')" @click="toggleActivity(projectGroup.name,'browser')"><span class="session-label"><span class="row-toggle"><ChevronRight :size="13" :class="{expanded:!activityCollapsed(projectGroup.name,'browser')}"/></span><span class="agent-symbol activity-symbol"><Globe2 :size="15"/></span><span><strong>Browser activity</strong><small>{{projectGroup.websites.length}} {{projectGroup.websites.length===1?'website':'websites'}}</small></span></span><span class="timeline-track"><span v-for="tick in ticks" :key="tick.time" class="grid-line" :class="{minor:!tick.major}" :style="{left:`${(tick.time-timelineStart)/timelineSpan*100}%`}"></span><span v-for="(interval,index) in projectGroup.browserBars" :key="index" class="time-block human" :style="barStyle(interval)" :title="`${tickClock(interval.start)}–${tickClock(interval.end)} · ${interval.browserTitle||interval.browserDomain||'Browser activity'} · credited human time`"></span></span><span class="time-total"><strong>{{duration(projectGroup.browserSeconds)}}</strong></span></button>
      <template v-if="!activityCollapsed(projectGroup.name,'browser')"><div v-for="site in projectGroup.websites" :key="site.key" class="timeline-row activity-detail-row"><div class="session-label"><span class="row-toggle-spacer"></span><span class="agent-symbol activity-symbol"><Globe2 :size="13"/></span><div><strong>{{site.label}}</strong><small>{{site.detail}}</small></div></div><div class="timeline-track"><span v-for="tick in ticks" :key="tick.time" class="grid-line" :class="{minor:!tick.major}" :style="{left:`${(tick.time-timelineStart)/timelineSpan*100}%`}"></span><span v-for="(interval,index) in site.bars" :key="index" class="time-block human" :style="barStyle(interval)" :title="`${tickClock(interval.start)}–${tickClock(interval.end)} · ${site.label}`"></span></div><span class="time-total"><strong>{{duration(site.seconds)}}</strong></span></div></template>
     </template>
     </template>
     </div>
     <div v-if="timelineEligible.length>timelineLimit&&timelineProjects.some(group=>!projectCollapsed(group.name))" class="more-rows"><span>Showing {{timelineLimit}} of {{timelineEligible.length}} sessions</span><button @click="timelineLimit+=40">Show 40 more</button></div>
     <div v-if="isToday&&now>=timelineStart&&now<=timelineStart+timelineSpan" class="timeline-cursor-track"><span class="timeline-cursor" :style="{left:cursorLeft}"><b>Now</b></span></div>
     <div class="timeline-legend"><span><i class="legend-human"></i>Credited human time</span><span><i class="legend-agent"></i>Credited agent time · observed workload above</span><span><i class="legend-child"></i>Subagent overlay on session rows</span><span class="legend-note">Purple height shows simultaneous agents · pale bars extend grouped activity to the one-minute credit</span></div>
    </TabsContent>
    <TabsContent value="sessions" class="sessions-table"><table><thead><tr><th>Session</th><th>Project / run</th><th>Status</th><th>Agent time</th><th>Observed tools</th><th>Evidence</th></tr></thead><tbody><tr v-for="session in visibleSessions.slice(0,tableLimit)" :key="session.key" tabindex="0" role="button" :aria-label="`View details for ${session.title}`" @click="selected=session" @keydown.enter="selected=session" @keydown.space.prevent="selected=session"><td><strong>{{session.title}}</strong><small>{{session.provider||'Unknown agent'}}{{session.child?' · Subagent':''}}</small></td><td :title="projectName(session)">{{projectDisplay(projectName(session),projects)}}<small>{{session.runId||'Independent session'}}</small></td><td><span :class="['state-pill',{working:['working','running'].includes(session.state)}]">{{session.state}}</span></td><td class="tabular">{{duration(session.seconds)}}</td><td class="tabular">{{duration(session.observedSeconds)}}</td><td>{{session.proof}}</td></tr><tr v-if="!visibleSessions.length"><td colspan="6" class="table-empty">No tracked sessions in this project for the selected day.</td></tr></tbody></table><div v-if="visibleSessions.length>tableLimit" class="more-rows"><span>Showing {{tableLimit}} of {{visibleSessions.length}} sessions</span><button @click="tableLimit+=100">Show 100 more</button></div></TabsContent>
   </TabsRoot>
   <div class="activity-note"><ShieldCheck :size="14"/><span>Local capture. Human activity is estimated; session timing shows its evidence.</span><span class="sync-note">{{orcaPollNote}}</span></div>
  </section>
  <CaptureHealthPage v-else :status="status" :issues="issues" @review-site="reviewSite"/>
  <footer class="statusbar"><button class="capture-status-link" @click="captureAttention?repairCapture():navigate('health')"><span :class="['status-dot',{live:status?.running&&!captureAttention}]"></span>{{captureLabel}}</button><span>{{native?'Desktop app':'Local browser preview'}} · {{summary.sessions.length}} discovered sessions</span></footer>
  <DialogRoot :open="Boolean(noteAnchor)" @update:open="!$event&&(noteAnchor=null)"><DialogPortal><DialogOverlay class="export-backdrop"/><DialogContent v-if="noteAnchor" as-child><form class="export-review note-dialog" @submit.prevent="saveNote"><DialogTitle>Note this {{noteAnchor.label}}</DialogTitle><DialogDescription>{{clock(noteAnchor.start)}}–{{clock(noteAnchor.end)}} · {{duration(noteAnchor.end-noteAnchor.start)}}. Notes are user entered and do not add to observed totals.</DialogDescription><label>Project label (optional)<input v-model="noteProject" placeholder="Project name"/></label><label>What happened?<textarea v-model="noteText" maxlength="500" required autofocus placeholder="Add context for this interval"/></label><p v-if="noteError" role="alert">{{noteError}}</p><div><button type="button" @click="noteAnchor=null">Cancel</button><button type="submit" :disabled="noteSaving||!noteText.trim()">Save note</button></div></form></DialogContent></DialogPortal></DialogRoot>
  <DialogRoot :open="exportOpen" @update:open="exportOpen=$event"><DialogPortal><DialogOverlay class="export-backdrop"/><DialogContent class="export-review"><DialogTitle>Review before export</DialogTitle><DialogDescription>{{selectedDate}} · {{project==='all'?'All projects':projectDisplay(project,projects)}}</DialogDescription><dl><dt>Reviewed groups</dt><dd>{{exportReviewGroups.filter(group=>Boolean(group.userAttribution)).length}}</dd><dt>Unmatched time</dt><dd>{{duration(exportReviewNeeds.reduce((total,group)=>total+group.seconds,0))}} · {{exportReviewNeeds.length}} groups</dd><dt>Conflicting evidence</dt><dd>{{exportReviewConflicts.length}} groups</dd><dt>Day-wide observation gaps</dt><dd>{{dayGaps.length}} gaps between observations</dd><dt>Day-wide source confidence</dt><dd>{{confidence.observed}} credited · {{confidence.attention}} need repair · {{confidence.caveats}} caveats</dd></dl><p>CSV includes credited observations and your project decisions. Session search does not change this export. Unobserved gaps are not counted as work.</p><div><button @click="exportOpen=false">Continue reviewing</button><button @click="exportCsv">Export CSV</button></div></DialogContent></DialogPortal></DialogRoot>
 </main>
 <aside v-if="selected" class="inspector"><div class="inspector-toolbar"><span>Session details</span><button class="icon-button" aria-label="Close session details" @click="selected=null"><X :size="16"/></button></div><span class="inspector-icon" :style="{color:color(selected)}"><Bot :size="27"/></span><h2>{{selected.title}}</h2><span class="state-pill">{{selected.state}}</span><dl><dt>Project</dt><dd :title="projectName(selected)">{{projectDisplay(projectName(selected),projects)}}</dd><dt>Agent</dt><dd>{{selected.provider||'Unknown'}}</dd><dt>Tracked agent time</dt><dd class="inspector-duration">{{duration(selected.seconds)}}</dd><dt>Observed tool time</dt><dd>{{duration(selected.observedSeconds)}}</dd><dt>Evidence</dt><dd>{{selected.proof}}</dd><dt>Orchestration run</dt><dd>{{selected.runId||'Independent session'}}</dd><dt>Task / attempt</dt><dd>{{selected.taskId||'Unassigned'}}<br/>{{selected.dispatchId||'No dispatch'}}</dd><dt>Provider session</dt><dd>{{selected.sessionId||'Not yet linked'}}</dd><dt>Workspace</dt><dd class="path">{{workspacePath(selected)}}</dd></dl><p class="inspector-note">Completed turns include time between tool hooks. Unmatched turns remain uncounted. Native child time is shown separately.</p></aside>
</div>

</TooltipProvider>
</template>
<style scoped>
.timeline{position:relative}.project-group-header{display:flex;align-items:center;gap:8px;padding:12px 15px;background:var(--panel);border-bottom:1px solid var(--border);font-size:12px}.project-group-header svg{color:var(--blue)}.project-group-header strong{font-weight:650}.project-group-header small{margin-left:auto;color:var(--muted);font-size:10px}.timeline-project+.timeline-project{border-top:2px solid var(--border)}.timeline-cursor-track{position:absolute;left:255px;right:113px;top:41px;bottom:43px;z-index:3;pointer-events:none}.timeline-cursor{position:absolute;top:0;bottom:0;width:2px;background:#ee6857;box-shadow:0 0 0 1px #ee685733}.timeline-cursor b{position:absolute;top:-25px;left:50%;transform:translateX(-50%);background:#ee6857;color:#fff;border-radius:4px;padding:3px 5px;font-size:9px;line-height:1;font-weight:700;white-space:nowrap}@media(max-width:1120px){.timeline-cursor-track{left:205px;right:97px}}
.day-capture-issues{margin:-7px 0 17px;border:1px solid #d4954260;border-radius:8px;background:#d4954212;font-size:11px}.day-capture-issues summary{display:flex;align-items:center;gap:8px;padding:9px 12px;cursor:pointer;color:var(--text)}.day-capture-issues summary svg{color:#c38329;flex:none}.day-capture-issues .issue-expand{margin-left:auto;color:var(--blue)}.day-capture-issues ul{margin:0;padding:0 18px 6px 35px;color:var(--muted);line-height:1.5}.day-capture-issues li{margin:0 0 5px}.day-capture-issues button{margin:0 0 10px 12px;color:var(--blue);font-size:11px}
.project-timeline-row{display:grid;grid-template-columns:240px minmax(80px,1fr) 98px;align-items:center;width:100%;height:72px;padding:0 15px;text-align:left;background:var(--hover);border-bottom:1px solid var(--border)}.project-timeline-row:hover{filter:brightness(.98)}.project-timeline-row:focus-visible{outline:2px solid var(--blue);outline-offset:-2px}.project-timeline-label{display:flex;align-items:center;gap:7px;min-width:0;padding-right:16px}.project-timeline-label>svg{flex:none;color:var(--muted);transition:transform .15s ease}.project-timeline-label>span:last-child{min-width:0}.project-timeline-label strong{display:block;font-size:12px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.project-timeline-label small{display:block;margin-top:5px;font-size:10px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.project-symbol{width:29px;height:29px;border-radius:7px;display:grid;place-items:center;flex:none;color:var(--blue);background:#007aff16}.project-timeline-row .time-total strong,.project-timeline-row .time-total small{display:block;white-space:nowrap}.project-timeline-row .time-total strong{font-size:10px;font-weight:650}.project-timeline-row .time-total small{font-size:9px;color:#c38329;margin-top:3px}.project-timeline-row .time-total .peak-count{color:#b69af0;font-weight:650}.project-timeline-row .timeline-track::before{content:"";position:absolute;left:0;right:0;bottom:11px;border-bottom:1px solid #7958d948;pointer-events:none}.project-timeline-row .timeline-track .time-block.human{top:auto;bottom:4px;height:6px;border-radius:0;background:#e49b3d;opacity:1}.project-timeline-row .timeline-track .agent-load-block{position:absolute;bottom:12px;min-width:1px;border-radius:0;background:linear-gradient(to top,#6846cb,#9976ed);pointer-events:auto}.timeline-row:not(.child) .session-label{padding-left:18px}.timeline-row.child .session-label{padding-left:38px}@media(max-width:1120px){.project-timeline-row{grid-template-columns:190px minmax(80px,1fr) 82px}.project-timeline-row .time-total .peak-count{font-size:8px}}
.activity-row{cursor:default}.activity-row .session-label{padding-left:18px}.activity-heading{cursor:pointer;text-align:left}.activity-heading .row-toggle svg{transition:transform .15s ease}.activity-heading .row-toggle svg.expanded{transform:rotate(90deg)}.activity-symbol{color:#c38329;background:#e49b3d16}.activity-row .timeline-track .time-block.human,.activity-detail-row .timeline-track .time-block.human{top:27px;height:17px}.timeline-row.activity-detail-row .session-label{padding-left:40px}.activity-detail-row{cursor:default}.activity-detail-row .agent-symbol{width:24px;height:24px}.activity-detail-row .session-label strong{font-size:10px}
.project-timeline-row{height:88px}.timeline-row .timeline-track .time-block.agent.credit{opacity:.28}.timeline-row .timeline-track .time-block.subagent.credit{opacity:.2}.project-timeline-row .timeline-track .time-block.agent-credit{top:auto;bottom:15px;height:6px;background:#b497f7;opacity:.55;z-index:1}.project-timeline-row .project-workload{overflow:visible}.project-timeline-row:hover .project-workload{z-index:5}.project-timeline-row .project-workload::before{bottom:14px}.project-timeline-row .project-workload .time-block.human{bottom:5px;height:7px}.workload-area{position:absolute;left:0;right:0;bottom:15px;width:100%;height:56px;overflow:visible;pointer-events:none}.workload-area path{fill:#7958d9;opacity:.88}.workload-scale{position:absolute;right:4px;top:10px;bottom:16px;display:flex;flex-direction:column;justify-content:space-between;align-items:flex-end;pointer-events:none;font-size:9px;color:#ad91f0;text-shadow:0 1px 3px var(--hover);font-variant-numeric:tabular-nums}.workload-scale b{font-weight:650}.workload-scale small{font-size:8px;color:var(--muted)}.workload-crosshair{position:absolute;top:9px;bottom:4px;width:1px;background:#c9c3dc;pointer-events:none;z-index:6}.workload-tooltip{position:absolute;top:-67px;z-index:7;transform:translateX(-50%);display:flex;flex-direction:column;gap:3px;min-width:206px;padding:7px 10px;border-radius:7px;border:1px solid #625875;background:#25212f;color:#ede8f8;box-shadow:0 5px 18px #0005;white-space:nowrap;text-align:left;font-size:10px;font-variant-numeric:tabular-nums;pointer-events:none}.workload-tooltip strong{font-size:11px;font-weight:650}.workload-tooltip span{color:#c9c3d2}
.workload-tooltip.below{top:calc(100% + 5px)}
.workload-scale small{margin-top:auto}
.timeline-zoom{height:84px;display:grid;grid-template-columns:240px minmax(80px,1fr) 98px;align-items:center;gap:0;padding:0 15px;border-bottom:1px solid var(--border);background:var(--panel)}
.zoom-caption{font-size:11px;font-weight:650;color:var(--text);padding-right:12px}.zoom-caption small{display:block;margin-top:5px;font-size:9px;font-weight:400;line-height:1.4;color:var(--muted)}
.timeline-overview-track{position:relative;height:42px;margin-right:4px;border:1px solid var(--border);border-radius:6px;background:var(--hover);overflow:hidden;touch-action:none;cursor:crosshair}
.timeline-track .grid-line.minor{opacity:.32}.overview-bar{position:absolute;height:6px;border-radius:1px;pointer-events:none}.overview-agent{top:10px;background:#7958d9;opacity:.75}.overview-human{bottom:10px;background:#e49b3d;opacity:.8}
.overview-selection{position:absolute;top:0;bottom:0;box-sizing:border-box;border:1px solid #a98beb;background:#7958d92b;cursor:grab}.overview-selection:active{cursor:grabbing}
.overview-handle{position:absolute;top:0;bottom:0;width:7px;background:#b99df7;cursor:ew-resize;z-index:1}.overview-handle.start{left:0}.overview-handle.end{right:0}.overview-selection.narrow .overview-handle.start{left:-8px}.overview-selection.narrow .overview-handle.end{right:-8px}.overview-selection.narrow.atStart .overview-handle.start{left:0}.overview-selection.narrow.atEnd .overview-handle.end{right:0}.overview-handle:focus-visible{outline:2px solid #fff;outline-offset:-2px}
.zoom-presets{display:grid;grid-template-columns:repeat(2,1fr);gap:3px;padding-left:7px}.zoom-presets button{padding:4px 1px;border:1px solid var(--border);border-radius:4px;background:var(--hover);color:var(--text);font-size:9px;white-space:nowrap}.zoom-presets button:hover,.zoom-presets button:focus-visible{border-color:#7958d9;color:#b99df7}
.timeline-cursor-track{top:125px}
@media(max-width:1120px){.timeline-zoom{grid-template-columns:190px minmax(80px,1fr) 82px}.zoom-presets button{font-size:8px}}
.day-confidence{margin:0 0 17px;border:1px solid var(--border);border-radius:8px;background:var(--panel);font-size:11px}.day-confidence summary{display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:pointer}.day-confidence summary svg{color:var(--blue)}.day-confidence summary span{color:var(--muted)}.day-confidence summary strong{font-size:11px}.confidence-sources{border-top:1px solid var(--border);padding:5px 12px 10px}.confidence-sources>div{display:flex;align-items:center;gap:9px;padding:7px 0}.confidence-sources>div+div{border-top:1px solid var(--border)}.confidence-sources strong{min-width:90px}.confidence-sources span{color:var(--muted);flex:1}.confidence-sources span.attention{color:#d49542}.confidence-sources button{color:var(--blue);font-size:10px}.confidence-sources p{margin:7px 0 0;color:var(--muted);font-size:10px}
.review-priority{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 14px;padding:12px 15px;border:1px solid var(--border);border-radius:9px;background:var(--panel)}.review-priority div{display:flex;flex-direction:column;gap:4px}.review-priority strong{font-size:13px}.review-priority span{font-size:11px;color:var(--muted)}.review-priority button{color:var(--blue);font-size:11px}.capture-status-link{display:flex;align-items:center;gap:7px;text-align:left;color:inherit;font-size:inherit}.capture-status-link:focus-visible,.review-priority button:focus-visible{outline:2px solid var(--blue)}.export-backdrop{position:fixed;inset:0;z-index:100;background:#0009}.export-review{position:fixed;z-index:101;top:50%;left:50%;transform:translate(-50%,-50%);width:min(450px,calc(100vw - 40px));padding:24px;border:1px solid var(--border);border-radius:12px;background:var(--panel);box-shadow:0 20px 60px #0007}.export-review h2{margin:0;font-size:18px}.export-review p{color:var(--muted);font-size:12px;line-height:1.5}.export-review dl{display:grid;grid-template-columns:1fr auto;gap:10px;font-size:12px}.export-review dt{color:var(--muted)}.export-review dd{margin:0;font-weight:650}.export-review>div{display:flex;justify-content:flex-end;gap:8px}.export-review button{padding:8px 12px;border:1px solid var(--border);border-radius:6px;color:var(--text)}.export-review button:last-child{background:var(--blue);color:#fff}
.review-priority small{font-size:10px;color:var(--muted)}.review-priority button:disabled{opacity:.5}.review-backlog{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:-4px 0 14px;padding:10px 13px;border:1px solid var(--border);border-radius:8px;font-size:11px}.review-backlog button{padding:5px 7px;border-radius:5px;background:var(--hover);color:var(--blue)}.review-backlog button:focus-visible{outline:2px solid var(--blue)}
.overlap-explainer{margin:10px 0 20px;padding:12px 15px;border:1px solid var(--border);border-radius:8px;background:var(--panel);font-size:11px}.overlap-explainer summary{display:flex;justify-content:space-between;gap:12px;cursor:pointer;font-weight:650}.overlap-explainer summary span{color:var(--muted);font-weight:400}.overlap-explainer p{margin:9px 0 0;color:var(--muted);line-height:1.5}.overlap-explainer p strong{color:var(--text)}.overlap-track{position:relative;height:16px;margin-top:12px;border-radius:5px;background:var(--hover);overflow:hidden}.overlap-track span{position:absolute;top:1px;bottom:1px;min-width:2px;background:#9b80d8}.overlap-track span.multiple{background:#5840ad}
.gap-timeline{display:grid;grid-template-columns:160px minmax(0,1fr) 210px;align-items:center;gap:12px;margin:16px 0;padding:12px 15px;border:1px solid var(--border);border-radius:8px;background:var(--panel)}.gap-timeline strong,.gap-timeline small{display:block}.gap-timeline strong{font-size:12px}.gap-timeline small{font-size:10px;color:var(--muted);line-height:1.4}.gap-track{position:relative;height:22px;background:var(--hover);border:1px solid var(--border);border-radius:5px;overflow:hidden}.gap-track button{position:absolute;top:0;bottom:0;min-width:3px;background:#d4954280;border-left:1px solid #d49542}.gap-track button:hover,.gap-track button:focus-visible{background:#d49542;outline:2px solid var(--blue)}.note-saved{color:#31a783;font-size:11px}.note-saved button{color:var(--blue);margin-left:8px}.note-dialog label{display:block;margin:12px 0;color:var(--muted);font-size:11px}.note-dialog input,.note-dialog textarea{display:block;box-sizing:border-box;width:100%;margin-top:5px;padding:9px;border:1px solid var(--border);border-radius:6px;background:var(--hover);color:var(--text);font:inherit}.note-dialog textarea{min-height:90px;resize:vertical}.note-dialog button:disabled{opacity:.5}@media(max-width:850px){.gap-timeline{grid-template-columns:1fr}.gap-track{height:28px}}
.metric-confidence{display:block;margin-top:3px;color:var(--muted);font-size:10px}.metric-confidence:first-letter{text-transform:uppercase}
.gap-note-list{grid-column:1/-1;border-top:1px solid var(--border);padding-top:6px}.gap-note-list p{margin:4px 0;font-size:11px;overflow-wrap:anywhere}.gap-note-list strong{color:var(--blue)}
.metric>small,.session-label small,.zoom-caption small,.metric-confidence,.timeline-header,.timeline-legend,.statusbar,th,td small{color:var(--muted);font-size:11px}.zoom-presets button,.estimate{font-size:11px}@media(max-width:1120px){.metric small{font-size:11px}.zoom-presets button{font-size:10px}}
</style>
