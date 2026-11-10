<script setup lang="ts">
import {computed,ref,watch,onMounted,onUnmounted} from 'vue';
import {AppWindow,Folder,ZoomIn,ZoomOut,ChevronLeft,ChevronRight,Maximize2} from '@lucide/vue';
import type {Interval} from '../capture/events.ts';
import {reviewTimelineBars,reviewTimelineRange,type AppReviewGroup} from './review-apps.ts';
import {zoomTimeRange,panTimeRange,timelineTicks,gridBackground} from './timeline-viewport.ts';
import {projectColor} from './project-identity.ts';
import {clock,preciseClock,duration} from './format.ts';

const props=defineProps<{date:string;intervals:Interval[];groups:AppReviewGroup[];selected:Record<string,boolean>;focused?:string}>();
const emit=defineEmits<{select:[id:string]}>();
const fit=()=>reviewTimelineRange(props.date,props.intervals,Date.now()/1000);
const range=ref(fit()),adjusted=ref(false),axis=ref<HTMLElement|null>(null),width=ref(720);
const bounds=computed(()=>{const day=new Date(`${props.date}T00:00:00`),start=day.getTime()/1000;day.setDate(day.getDate()+1);return {start,end:day.getTime()/1000};});
watch([()=>props.date,()=>props.intervals],([date],[previous])=>{if(date!==previous)adjusted.value=false;if(!adjusted.value)range.value=fit();});
const bars=computed(()=>reviewTimelineBars(props.intervals,props.groups,range.value));
const ticks=computed(()=>{const major=timelineTicks(range.value).filter(t=>t.major),stride=Math.max(1,Math.ceil(major.length/Math.max(2,Math.floor(width.value/72))));return major.filter((_t,index)=>index%stride===0);});
const grid=computed(()=>{const value=gridBackground(range.value);return {backgroundSize:value.size,backgroundPosition:value.position};});
const percent=(time:number)=>(time-range.value.start)/(range.value.end-range.value.start)*100;
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
      <div class="ribbon-track" :style="grid">
        <button v-for="(bar,index) in bars" :key="bar.key" class="ribbon-bar" :class="{selected:selected[bar.groupId],focused:focused===bar.groupId}"
          :style="{left:percent(bar.start)+'%',width:(percent(bar.end)-percent(bar.start))+'%',background:lane==='app'?projectColor('app:'+bar.appKey):bar.projectPath?projectColor(bar.projectPath):'var(--border-strong)'}"
          :title="`${bar.appName} · ${preciseClock(bar.start)}–${preciseClock(bar.end)} · ${duration(bar.end-bar.start)}${lane==='project'?' · '+(bar.projectPath||'Unassigned'):''}`"
          :aria-label="`Select ${bar.appName} activity at ${preciseClock(bar.start)}`" :aria-pressed="Boolean(selected[bar.groupId])"
          :tabindex="focused===bar.groupId||index===0?0:-1" @click="emit('select',bar.groupId)" />
      </div>
    </div>
    <p>Foreground observations · select an app or activity below for the same periods. Gaps stay separate.</p>
  </div>
</template>

<style scoped>
.review-timeline{padding:13px 0 16px;border-bottom:1px solid var(--border);margin-bottom:17px}
.ribbon-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:15px;color:var(--muted);font-size:var(--text-xs);font-variant-numeric:tabular-nums}
.ribbon-toolbar>div{display:flex;gap:3px}.ribbon-toolbar button{padding:5px;min-height:28px}.ribbon-toolbar svg{width:14px;height:14px;flex:none}
.ribbon-axis-row,.ribbon-row{display:grid;grid-template-columns:105px minmax(0,1fr);gap:12px;align-items:center}.ribbon-axis-row{margin-bottom:8px}.ribbon-axis{height:17px;position:relative;margin:0 23px}
.ribbon-axis>span{position:absolute;transform:translateX(-50%);font-size:var(--text-xs);color:var(--muted);white-space:nowrap;font-variant-numeric:tabular-nums}
.ribbon-row{margin-top:7px}.ribbon-label{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:var(--text-xs)}.ribbon-label svg{flex:none}
.ribbon-track{position:relative;height:29px;margin:0 23px;background-image:linear-gradient(to right,var(--border) 1px,transparent 1px),linear-gradient(to right,color-mix(in srgb,var(--border) 45%,transparent) 1px,transparent 1px);background-repeat:repeat-x;isolation:isolate}
.ribbon-bar{position:absolute;top:3px;bottom:3px;padding:0;min-width:0;border:0;border-radius:2px;opacity:.85;cursor:pointer}.ribbon-bar:hover,.ribbon-bar.focused{opacity:1;z-index:1}.ribbon-bar.selected{outline:2px solid var(--text);outline-offset:1px;z-index:2;opacity:1}.ribbon-bar:focus-visible{outline:2px solid var(--accent);outline-offset:2px;z-index:3}
.review-timeline>p{margin:12px 23px 0 117px;color:var(--muted);font-size:var(--text-xs)}
@media(max-width:560px){.ribbon-axis-row,.ribbon-row{grid-template-columns:73px minmax(0,1fr);gap:6px}.ribbon-track,.ribbon-axis{margin:0 20px}.review-timeline>p{margin-left:79px}.ribbon-label{font-size:11px}.ribbon-label svg{display:none}}
</style>
