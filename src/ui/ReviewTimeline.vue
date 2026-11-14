<script setup lang="ts">
import {computed,ref,watch,onMounted,onUnmounted} from 'vue';
import {AppWindow,Folder,ZoomIn,ZoomOut,ChevronLeft,ChevronRight,Maximize2} from '@lucide/vue';
import type {Interval} from '../capture/events.ts';
import {reviewTimelineBars,reviewTimelineRange,type AppReviewGroup} from './review-apps.ts';
import {reviewTimelineHit} from './review-timeline-hit.ts';
import {zoomTimeRange,panTimeRange,timelineTicks,gridBackground} from './timeline-viewport.ts';
import {projectColor} from './project-identity.ts';
import {clock,preciseClock,duration} from './format.ts';

const props=defineProps<{date:string;intervals:Interval[];groups:AppReviewGroup[];selected:Record<string,boolean>;focusedIds?:Record<string,boolean>}>();
const emit=defineEmits<{select:[id:string,additive:boolean]}>();
const fit=()=>reviewTimelineRange(props.date,props.intervals,Date.now()/1000);
const range=ref(fit()),adjusted=ref(false),axis=ref<HTMLElement|null>(null),width=ref(720);
const bounds=computed(()=>{const day=new Date(`${props.date}T00:00:00`),start=day.getTime()/1000;day.setDate(day.getDate()+1);return {start,end:day.getTime()/1000};});
watch([()=>props.date,()=>props.intervals],([date],[previous])=>{if(date!==previous)adjusted.value=false;if(!adjusted.value)range.value=fit();});
const bars=computed(()=>reviewTimelineBars(props.intervals,props.groups,range.value));
const ticks=computed(()=>{const major=timelineTicks(range.value).filter(t=>t.major),stride=Math.max(1,Math.ceil(major.length/Math.max(2,Math.floor(width.value/72))));return major.filter((_t,index)=>index%stride===0);});
const grid=computed(()=>{const value=gridBackground(range.value);return {backgroundSize:value.size,backgroundPosition:value.position};});
const percent=(time:number)=>(time-range.value.start)/(range.value.end-range.value.start)*100;
type Lane='app'|'project';
const inspected=ref<Record<Lane,number>>({app:0,project:0}),hovered=ref<Record<Lane,number>>({app:-1,project:-1});
const spanPath=(start:number,end:number)=>{const left=percent(start)*10,right=percent(end)*10;return `M${left},3H${right}V26H${left}Z`;};
function lanePaths(selectedOnly=false){
  const lanes:{app:Array<{key:string;color:string;d:string}>;project:Array<{key:string;color:string;d:string}>}={app:[],project:[]};
  for(const lane of ['app','project'] as const){
    const categories=new Map<string,{key:string;color:string;d:string}>();
    for(const bar of bars.value){
      if(selectedOnly&&!props.selected[bar.groupId])continue;
      const category=lane==='app'?'app:'+bar.appKey:bar.projectPath||'unassigned';
      let path=categories.get(category);
      if(!path){path={key:category,color:lane==='project'&&!bar.projectPath?'var(--border-strong)':projectColor(category),d:''};categories.set(category,path);}
      path.d+=spanPath(bar.start,bar.end);
    }
    lanes[lane]=[...categories.values()];
  }
  return lanes;
}
const paths=computed(()=>lanePaths());
const selectedPaths=computed(()=>lanePaths(true));

const selectedPath=computed(()=>bars.value.filter(bar=>props.selected[bar.groupId]).map(bar=>spanPath(bar.start,bar.end)).join(''));
const focusedPath=computed(()=>bars.value.filter(bar=>props.focusedIds?.[bar.groupId]).map(bar=>spanPath(bar.start,bar.end)).join(''));
watch(bars,()=>{
  const index=bars.value.findIndex(bar=>props.focusedIds?.[bar.groupId]);
  for(const lane of ['app','project'] as const){inspected.value[lane]=index>=0?index:Math.min(inspected.value[lane],Math.max(0,bars.value.length-1));hovered.value[lane]=-1;}
});
watch(()=>props.focusedIds,ids=>{const index=bars.value.findIndex(bar=>ids?.[bar.groupId]);if(index>=0)inspected.value={app:index,project:index};});
function description(index:number,lane:Lane){
  const bar=bars.value[index];
  return bar?`${bar.appName} · ${preciseClock(bar.start)}–${preciseClock(bar.end)} · ${duration(bar.end-bar.start)}${lane==='project'?' · '+(bar.projectPath||'Unassigned'):''}`:'';
}
function inspectionLabel(lane:Lane){
  const label=lane==='app'?'App usage':'Project';
  return `${label}: ${description(inspected.value[lane],lane)||'No observations'}. Left and right arrows inspect visits; Enter or Space selects.`;
}
function pointerIndex(event:MouseEvent){
  const rect=(event.currentTarget as HTMLElement).getBoundingClientRect();
  if(!rect.width)return -1;
  return reviewTimelineHit(bars.value,range.value.start+(event.clientX-rect.left)/rect.width*(range.value.end-range.value.start));
}
function choose(event:MouseEvent,lane:Lane){
  const index=event.detail===0?inspected.value[lane]:pointerIndex(event),bar=bars.value[index];
  if(bar){inspected.value[lane]=index;emit('select',bar.groupId,event.metaKey||event.ctrlKey||event.shiftKey);}
}
function inspect(event:KeyboardEvent,lane:Lane){
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
  event.preventDefault();
  const last=Math.max(0,bars.value.length-1),current=inspected.value[lane];
  inspected.value[lane]=event.key==='Home'?0:event.key==='End'?last:Math.max(0,Math.min(last,current+(event.key==='ArrowLeft'?-1:1)));
}
function zoom(factor:number){adjusted.value=true;range.value=zoomTimeRange(range.value,(range.value.start+range.value.end)/2,factor,bounds.value.start,bounds.value.end);}
function pan(direction:number){adjusted.value=true;range.value=panTimeRange(range.value,direction*(range.value.end-range.value.start)/2,bounds.value.start,bounds.value.end);}
function reset(){adjusted.value=false;range.value=fit();}
let observer:ResizeObserver|undefined;
onMounted(()=>{if(typeof ResizeObserver!=='undefined'&&axis.value){observer=new ResizeObserver(entries=>{width.value=entries[0]?.contentRect.width||720;});observer.observe(axis.value);}});
onUnmounted(()=>observer?.disconnect());
</script>

<template>
  <div class="review-timeline" aria-label="Observed app activity and project assignments">
    <div class="ribbon-toolbar">
      <span>{{ clock(range.start) }}–{{ clock(range.end) }}</span>
      <div role="group" aria-label="Activity timeline viewport">
        <button class="btn btn-quiet btn-sm" aria-label="Earlier activity" @click="pan(-1)"><ChevronLeft :size="14" /></button>
        <button class="btn btn-quiet btn-sm" aria-label="Zoom out activity" @click="zoom(2)"><ZoomOut :size="14" /></button>
        <button class="btn btn-quiet btn-sm" aria-label="Zoom in activity" @click="zoom(.5)"><ZoomIn :size="14" /></button>
        <button class="btn btn-quiet btn-sm" aria-label="Fit observed activity" @click="reset"><Maximize2 :size="14" /></button>
        <button class="btn btn-quiet btn-sm" aria-label="Later activity" @click="pan(1)"><ChevronRight :size="14" /></button>
      </div>
    </div>
    <div class="ribbon-axis-row"><span /><div ref="axis" class="ribbon-axis"><span v-for="tick in ticks" :key="tick.time" :style="{left:percent(tick.time)+'%'}">{{ clock(tick.time) }}</span></div></div>
    <div v-for="lane in ['app','project'] as const" :key="lane" class="ribbon-row">
      <span class="ribbon-label"><AppWindow v-if="lane==='app'" :size="13" /><Folder v-else :size="13" />{{ lane==='app'?'App usage':'Project' }}</span>
      <button type="button" class="ribbon-track" :style="grid" :disabled="!bars.length"
        :aria-label="inspectionLabel(lane)" :title="description(hovered[lane],lane)||undefined"
        @click="choose($event,lane)" @keydown="inspect($event,lane)"
        @mousemove="hovered[lane]=pointerIndex($event)" @mouseleave="hovered[lane]=-1">
        <svg viewBox="0 0 1000 29" preserveAspectRatio="none" aria-hidden="true">
          <path v-for="path in paths[lane]" :key="path.key" :d="path.d" :fill="path.color" :opacity="selectedPath.length ? 0.22 : 1" />
          <path v-for="path in selectedPaths[lane]" :key="'selected-'+path.key" :d="path.d" :fill="path.color" />
          <path v-if="focusedPath" :d="focusedPath" class="ribbon-focused" />
          <path v-if="selectedPath" :d="selectedPath" class="ribbon-selected" />
          <path v-if="bars[inspected[lane]]" :d="spanPath(bars[inspected[lane]]!.start,bars[inspected[lane]]!.end)" class="ribbon-inspected" />
        </svg>
        <span class="ribbon-inspection" aria-hidden="true">{{ description(inspected[lane],lane) }}</span>
      </button>
    </div>
    <p>Foreground observations · click an activity or select rows below to highlight the same periods. ⌘/Ctrl-click adds to the selection. Gaps stay separate.</p>
  </div>
</template>

<style scoped>
.review-timeline{padding:13px 0 16px;border-bottom:1px solid var(--border);margin-bottom:17px}
.ribbon-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:15px;color:var(--muted);font-size:var(--text-xs);font-variant-numeric:tabular-nums}
.ribbon-toolbar>div{display:flex;gap:3px}.ribbon-toolbar button{padding:5px;min-height:28px}.ribbon-toolbar svg{width:14px;height:14px;flex:none}
.ribbon-axis-row,.ribbon-row{display:grid;grid-template-columns:105px minmax(0,1fr);gap:12px;align-items:center}.ribbon-axis-row{margin-bottom:8px}.ribbon-axis{height:17px;position:relative;margin:0 23px}
.ribbon-axis>span{position:absolute;transform:translateX(-50%);font-size:var(--text-xs);color:var(--muted);white-space:nowrap;font-variant-numeric:tabular-nums}
.ribbon-row{margin-top:7px}.ribbon-label{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:var(--text-xs)}.ribbon-label svg{flex:none}
.ribbon-track{position:relative;display:block;min-width:0;width:calc(100% - 46px);height:29px;margin:0 23px;padding:0;border:0;border-radius:0;background-color:transparent;background-image:linear-gradient(to right,var(--border) 1px,transparent 1px),linear-gradient(to right,color-mix(in srgb,var(--border) 45%,transparent) 1px,transparent 1px);background-repeat:repeat-x;isolation:isolate;cursor:crosshair}
.ribbon-track>svg{display:block;width:100%;height:100%;overflow:visible;pointer-events:none;opacity:.85}.ribbon-track:hover>svg{opacity:1}.ribbon-track path{vector-effect:non-scaling-stroke}.ribbon-focused{fill:none;stroke:var(--accent);stroke-width:1}.ribbon-selected{fill:none;stroke:var(--text);stroke-width:2}.ribbon-inspected{display:none;fill:none;stroke:var(--accent);stroke-width:2}.ribbon-track:focus-visible{outline:2px solid var(--accent);outline-offset:3px}.ribbon-track:focus-visible .ribbon-inspected{display:block}.ribbon-inspection{display:none;position:absolute;bottom:calc(100% + 5px);right:0;padding:5px 8px;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:4px;font-size:var(--text-xs);white-space:nowrap;z-index:4;pointer-events:none}.ribbon-track:focus-visible .ribbon-inspection{display:block}
.review-timeline>p{margin:12px 23px 0 117px;color:var(--muted);font-size:var(--text-xs)}
@media(max-width:560px){.ribbon-axis-row,.ribbon-row{grid-template-columns:73px minmax(0,1fr);gap:6px}.ribbon-track,.ribbon-axis{margin:0 20px}.ribbon-track{width:calc(100% - 40px)}.ribbon-inspection{max-width:80vw;white-space:normal}.review-timeline>p{margin-left:79px}.ribbon-label{font-size:11px}.ribbon-label svg{display:none}}
</style>
