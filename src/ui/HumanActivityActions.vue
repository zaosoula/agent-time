<script setup lang="ts">
import {computed,ref} from 'vue';
import {DropdownMenuRoot,DropdownMenuTrigger,DropdownMenuPortal,DropdownMenuContent} from 'reka-ui';
import {useRetainedOpen} from './page-presentation.ts';
import ReviewProjectActions from './ReviewProjectActions.vue';
import {beginReviewDrag} from './review-workspace.ts';
import type {AppReviewGroup} from './review-apps.ts';
import {duration} from './format.ts';
const props=defineProps<{date:string;groups:AppReviewGroup[];projects:string[];busy:boolean}>();
const emit=defineEmits<{assign:[groups:AppReviewGroup[],project:string|null];inspect:[groups:AppReviewGroup[],invoker:HTMLElement|null]}>();
const open=ref(false),presented=useRetainedOpen(open),trigger=ref<HTMLElement|null>(null);
let inspecting=false;
function inspect(){inspecting=true;emit('inspect',props.groups,trigger.value);}
function closeMenu(event:Event){if(inspecting){event.preventDefault();inspecting=false;}}
const scope=computed(()=>`${props.groups.length} visits · ${duration(props.groups.reduce((sum,g)=>sum+g.seconds,0))}`);
function drag(event:DragEvent){if(!props.busy&&event.dataTransfer)beginReviewDrag(props.date,props.groups,event.dataTransfer);else event.preventDefault();}
</script>
<template>
 <span v-if="groups.length" class="human-activity-actions" :draggable="!busy" @dragstart.stop="drag">
  <DropdownMenuRoot v-model:open="presented">
   <DropdownMenuTrigger as-child><button ref="trigger" class="btn btn-sm" @click="trigger=$event.currentTarget as HTMLElement" :disabled="busy" :aria-label="`Assign ${scope}`">Assign · {{scope}}</button></DropdownMenuTrigger>
   <DropdownMenuPortal><DropdownMenuContent @close-auto-focus="closeMenu" class="review-project-menu" :side-offset="5"><ReviewProjectActions :projects="projects" :busy="busy" :scope-label="scope" can-inspect @assign="emit('assign',groups,$event)" @inspect="inspect" /></DropdownMenuContent></DropdownMenuPortal>
  </DropdownMenuRoot>
 </span>
</template>
<style scoped>.human-activity-actions{display:inline-flex;flex:none;margin-left:8px;cursor:grab}</style>
