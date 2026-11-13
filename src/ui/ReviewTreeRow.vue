<script setup lang="ts">
import {computed,ref} from 'vue';
import {ChevronRight,Ellipsis,Check} from '@lucide/vue';
import {ContextMenuRoot,ContextMenuTrigger,ContextMenuPortal,ContextMenuContent,DropdownMenuRoot,DropdownMenuTrigger,DropdownMenuPortal,DropdownMenuContent} from 'reka-ui';
import {reviewGroupId,reviewAssignmentLabel,reviewIsAssigned,type AppReviewGroup} from './review-apps.ts';
import type {ReviewNode} from './review-tree.ts';
import ReviewProjectActions from './ReviewProjectActions.vue';

const props=withDefaults(defineProps<{node:ReviewNode;depth?:number;expanded:Record<string,boolean>;selected:Record<string,boolean>;projects:string[];busy:boolean;selectionSummary?:{seconds:number;visits:number}}>(),{depth:0});
const emit=defineEmits<{toggle:[key:string];select:[node:ReviewNode,checked:boolean];assign:[node:ReviewNode,project:string|null];inspect:[group:AppReviewGroup];drag:[node:ReviewNode,event:DragEvent]}>();
const contextOpen=ref(false);
const open=computed(()=>Boolean(props.expanded[props.node.key]));
const checkedCount=computed(()=>props.node.groups.filter(group=>props.selected[reviewGroupId(group)]).length);
const checked=computed(()=>props.node.groups.length>0&&checkedCount.value===props.node.groups.length);
const partial=computed(()=>checkedCount.value>0&&!checked.value);
const assigned=computed(()=>props.node.groups.length>0&&props.node.groups.every(reviewIsAssigned));
const currentProject=computed(()=>{
  const paths=new Set(props.node.groups.map(group=>reviewIsAssigned(group)?group.projectPath!:null));
  return paths.size===1?[...paths][0]:undefined;
});
const assignment=computed(()=>{
  const labels=[...new Set(props.node.groups.map(reviewAssignmentLabel))];
  if(labels.length===1)return labels[0];
  if(assigned.value&&currentProject.value)return currentProject.value.split('/').filter(Boolean).at(-1)||currentProject.value;
  return assigned.value?'Multiple projects':'Mixed assignment';
});
const assignmentTitle=computed(()=>[...new Set(props.node.groups.map(reviewAssignmentLabel))].join('\n'));
const canInspect=computed(()=>props.node.kind==='visit'&&props.node.groups.length===1);
function formatDuration(value:number){
  const seconds=Math.max(0,Math.round(value));
  if(seconds<60)return `${seconds}s`;
  const minutes=Math.floor(seconds/60);
  return minutes<60?`${minutes}m`:`${Math.floor(minutes/60)}h ${minutes%60}m`;
}
const duration=computed(()=>formatDuration(props.node.seconds));
const usesSelection=computed(()=>checkedCount.value>0&&Boolean(props.selectionSummary));
const scope=computed(()=>usesSelection.value?props.selectionSummary!:{seconds:props.node.seconds,visits:props.node.groups.length});
const scopeLabel=computed(()=>`Assign ${formatDuration(scope.value.seconds)} · ${scope.value.visits} ${scope.value.visits===1?'visit':'visits'}${usesSelection.value?' · selection':''}`);
const description=computed(()=>{
  const text=props.node.description||'';
  const suffixes=['Mixed assignments',...props.node.groups.map(reviewAssignmentLabel)].sort((a,b)=>b.length-a.length);
  for(const suffix of suffixes){
    if(text===suffix)return '';
    if(text.endsWith(` · ${suffix}`))return text.slice(0,-suffix.length-3);
  }
  return text;
});
function inspect(){if(canInspect.value)emit('inspect',props.node.groups[0]!);}
let dragFromControl=false;
function pointerdown(event:PointerEvent){dragFromControl=event.target instanceof Element&&Boolean(event.target.closest('button,input,[role="menuitem"]'));}
function drag(event:DragEvent){
  if(props.busy||dragFromControl||(event.target instanceof Element&&event.target.closest('button,input,[role="menuitem"]'))){event.preventDefault();return;}
  emit('drag',props.node,event);
}
function focusSearch(event:Event){
  event.preventDefault();
  (event.target as HTMLElement)?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
}
function keydown(event:KeyboardEvent){
  if(event.target!==event.currentTarget)return;
  if(!props.busy&&(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10')){event.preventDefault();contextOpen.value=true;return;}
  if((event.key==='ArrowRight'&&!open.value||event.key==='ArrowLeft'&&open.value)&&props.node.children.length){event.preventDefault();emit('toggle',props.node.key);}
  if(event.key===' '&&!props.busy){event.preventDefault();emit('select',props.node,!checked.value);}
}
</script>

<template>
  <div class="review-tree-branch">
    <ContextMenuRoot v-model:open="contextOpen">
      <ContextMenuTrigger as-child :disabled="busy">
        <div :id="`review-tree-${node.key}`" class="review-tree-row" :class="{'is-selected':checked||partial,'is-aggregate':node.children.length}" :style="{'--review-depth':depth}" tabindex="0" :draggable="!busy" :title="`${scopeLabel}; drag to a project`" :aria-label="`${node.label}, ${duration}, ${assignment}`" @contextmenu.stop @pointerdown.capture="pointerdown" @keydown="keydown" @dragstart.stop="drag">
          <button v-if="node.children.length" type="button" class="review-tree-expand" :aria-expanded="open" :aria-label="`${open?'Collapse':'Expand'} ${node.label}`" draggable="false" @dragstart.prevent.stop @click.stop="emit('toggle',node.key)"><ChevronRight :size="14" :class="{'is-open':open}" /></button>
          <span v-else class="review-tree-expand-spacer" />
          <input type="checkbox" class="review-tree-check" :checked="checked" :indeterminate="partial" :aria-checked="partial?'mixed':checked" :aria-label="`Select ${node.label} and its visits`" :disabled="busy||!node.groups.length" draggable="false" @dragstart.prevent.stop @click.stop @change="emit('select',node,($event.target as HTMLInputElement).checked)" />
          <span class="review-tree-name"><span class="review-tree-label" :title="node.label">{{ node.label }}</span><span v-if="description" class="review-tree-description" :title="description">{{ description }}</span></span>
          <span class="review-tree-assignment" :title="assignmentTitle"><Check v-if="assigned" :size="11" aria-hidden="true" /><span>{{ assignment }}</span></span>
          <span class="review-tree-duration">{{ duration }}</span>
          <DropdownMenuRoot>
            <DropdownMenuTrigger as-child><button type="button" class="review-tree-actions" :aria-label="`Assign ${node.label} to a project`" :disabled="busy" draggable="false" @dragstart.prevent.stop @click.stop><Ellipsis :size="16" /></button></DropdownMenuTrigger>
            <DropdownMenuPortal><DropdownMenuContent class="review-tree-menu" @open-auto-focus="focusSearch" align="end" :side-offset="5"><ReviewProjectActions :scope-label="scopeLabel" :projects="projects" :busy="busy" :current-project="currentProject" :can-inspect="canInspect" @assign="emit('assign',node,$event)" @inspect="inspect" /></DropdownMenuContent></DropdownMenuPortal>
          </DropdownMenuRoot>
        </div>
      </ContextMenuTrigger>
      <ContextMenuPortal><ContextMenuContent class="review-tree-menu" @open-auto-focus="focusSearch"><ReviewProjectActions context :scope-label="scopeLabel" :projects="projects" :busy="busy" :current-project="currentProject" :can-inspect="canInspect" @assign="emit('assign',node,$event)" @inspect="inspect" /></ContextMenuContent></ContextMenuPortal>
    </ContextMenuRoot>
    <template v-if="open">
      <ReviewTreeRow v-for="child in node.children" :key="child.key" :node="child" :depth="depth+1" :selection-summary="selectionSummary" :expanded="expanded" :selected="selected" :projects="projects" :busy="busy" @toggle="emit('toggle',$event)" @select="(node,checked)=>emit('select',node,checked)" @assign="(node,project)=>emit('assign',node,project)" @inspect="emit('inspect',$event)" @drag="(node,event)=>emit('drag',node,event)" />
    </template>
  </div>
</template>

<style scoped>
.review-tree-row{display:flex;align-items:center;gap:8px;min-height:38px;padding:3px 8px 3px calc(8px + var(--review-depth)*18px);border-bottom:1px solid var(--border);color:var(--text);font-size:var(--text-sm);cursor:grab;box-sizing:border-box}
.review-tree-row:hover{background:var(--surface)}
.review-tree-row.is-selected{background:var(--accent-soft)}
.review-tree-row:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.review-tree-row:active{cursor:grabbing}
.review-tree-expand,.review-tree-actions{display:inline-flex;align-items:center;justify-content:center;flex:none;width:25px;height:26px;padding:0;border:0;background:transparent;color:var(--muted);border-radius:5px;cursor:pointer}
.review-tree-expand:hover,.review-tree-actions:hover{background:var(--border);color:var(--text)}
.review-tree-expand:focus-visible,.review-tree-actions:focus-visible,.review-tree-check:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.review-tree-expand svg{transition:transform .15s}
.review-tree-expand svg.is-open{transform:rotate(90deg)}
.review-tree-expand-spacer{flex:none;width:25px}
.review-tree-check{flex:none;margin:0;width:14px;height:14px;accent-color:var(--accent);cursor:pointer}
.review-tree-name{display:flex;align-items:baseline;gap:10px;min-width:0;flex:1}
.review-tree-label,.review-tree-description{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.review-tree-label{min-width:0}
.is-aggregate>.review-tree-name>.review-tree-label{font-weight:600}
.review-tree-description{color:var(--muted);font-size:var(--text-xs)}
.review-tree-assignment{display:flex;align-items:center;gap:4px;max-width:220px;min-width:0;color:var(--muted);font-size:var(--text-xs)}
.review-tree-assignment span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.review-tree-duration{flex:none;min-width:60px;text-align:right;color:var(--muted);font-variant-numeric:tabular-nums;font-size:var(--text-xs)}
:global(.review-tree-menu){z-index:100;outline:0;max-height:var(--reka-popper-available-height,calc(100vh - 16px));overflow-y:auto}
@media(max-width:760px){.review-tree-name{align-items:flex-start;flex-direction:column;gap:1px}.review-tree-label,.review-tree-description{max-width:100%}.review-tree-assignment{max-width:120px}.review-tree-row{gap:5px;padding-left:calc(4px + var(--review-depth)*12px)}}
@media(prefers-reduced-motion:reduce){.review-tree-expand svg{transition:none}}
</style>
