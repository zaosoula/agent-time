<script setup lang="ts">
import type {ReviewLayout,ReviewGrouping} from './review-tree.ts';
import {defaultReviewGrouping} from './review-tree.ts';
import {SlidersHorizontal} from '@lucide/vue';
const props=defineProps<{layout:ReviewLayout;grouping:ReviewGrouping}>();
const emit=defineEmits<{'update:layout':[value:ReviewLayout];'update:grouping':[value:ReviewGrouping]}>();
const views=[{id:'unified',label:'Unified'},{id:'category',label:'By category'},{id:'chronological',label:'Chronological'}] as const;
function update<K extends keyof ReviewGrouping>(key:K,value:ReviewGrouping[K]){emit('update:grouping',{...props.grouping,[key]:value});}
</script>
<template>
 <div class="review-view-controls">
  <div class="view-switch" role="group" aria-label="Activity layout"><button v-for="view in views" :key="view.id" class="btn btn-sm" :aria-pressed="layout===view.id" :class="{active:layout===view.id}" @click="emit('update:layout',view.id)">{{view.label}}</button></div>
  <details class="grouping-controls"><summary><SlidersHorizontal :size="14" />Grouping</summary>
   <div class="grouping-options">
    <p>Display only. Recorded time and project assignments stay unchanged.</p>
    <p v-if="layout==='chronological'">Chronological shows individual visits in time order. These grouping options apply to the other views.</p>
    <fieldset :disabled="layout==='chronological'">
     <label><input type="checkbox" :checked="grouping.byProject" @change="update('byProject',($event.target as HTMLInputElement).checked)" />Group by project</label>
     <label><input type="checkbox" :checked="grouping.byDevice" @change="update('byDevice',($event.target as HTMLInputElement).checked)" />Group by device</label>
     <label><input type="checkbox" :checked="grouping.combineBrowsers" :disabled="layout!=='unified'" @change="update('combineBrowsers',($event.target as HTMLInputElement).checked)" />Combine websites across browsers (Unified)</label>
     <label class="select-label">Group pages by<select aria-label="Group pages by" :value="grouping.pageBy" @change="update('pageBy',($event.target as HTMLSelectElement).value as 'path'|'title')"><option value="path">Page URL</option><option value="title">Page title</option></select></label>
     <label class="select-label">Collapse activities shorter than<select aria-label="Collapse activities shorter than" :value="grouping.shortSeconds" @change="update('shortSeconds',Number(($event.target as HTMLSelectElement).value))"><option :value="0">Do not collapse</option><option v-for="seconds in [5,15,30,60]" :key="seconds" :value="seconds">{{seconds}} seconds</option></select></label>
    </fieldset>
    <button class="btn btn-quiet btn-sm" @click="emit('update:grouping',{...defaultReviewGrouping})">Reset grouping</button>
   </div>
  </details>
 </div>
</template>
<style scoped>
.review-view-controls{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:14px 0}.view-switch{display:flex;gap:2px;padding:3px;border:1px solid var(--border);border-radius:var(--radius-inner);background:var(--surface)}.view-switch .active{background:var(--accent-soft);color:var(--text)}
.grouping-controls{max-width:100%;border:1px solid var(--border);border-radius:var(--radius-inner);background:var(--panel)}summary{display:flex;align-items:center;gap:7px;padding:8px 12px;cursor:pointer;color:var(--muted);font-size:var(--text-sm)}summary:focus-visible{outline:2px solid var(--accent)}.grouping-options{padding:0 14px 12px;width:min(365px,75vw);font-size:var(--text-sm)}.grouping-options p{color:var(--muted);line-height:1.5;margin:8px 0 12px}fieldset{border:0;margin:0;padding:0;display:grid;gap:12px}fieldset:disabled{opacity:.55}label{display:flex;align-items:center;gap:8px}.select-label{display:grid;gap:6px}select{width:100%;min-height:var(--control-height,36px);border:1px solid var(--border);border-radius:var(--radius-inner);background:var(--surface);color:var(--text);padding:7px 9px}.grouping-options>button{margin-top:12px}
</style>
