<script setup lang="ts">
import {computed,ref} from 'vue';
import {ContextMenuItem,DropdownMenuItem} from 'reka-ui';
import {Check,Search} from '@lucide/vue';

const props=defineProps<{projects:string[];busy:boolean;context?:boolean;currentProject?:string|null;canInspect?:boolean;scopeLabel?:string}>();
const emit=defineEmits<{assign:[project:string|null];inspect:[]}>();
const query=ref('');
const root=ref<HTMLElement>();
const item=computed(()=>props.context?ContextMenuItem:DropdownMenuItem);
const projects=computed(()=>[...new Set(props.projects)].filter(path=>path.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())));
const name=(path:string)=>path.split('/').filter(Boolean).at(-1)||path;
function searchKey(event:KeyboardEvent){
  // Keep text editing out of the menu's typeahead, but retain Escape and Tab.
  if(event.key==='Escape'||event.key==='Tab')return;
  event.stopPropagation();
  if(event.key==='Enter')event.preventDefault();
  if(event.key==='ArrowDown'||event.key==='ArrowUp'){
    event.preventDefault();
    const items=root.value?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([data-disabled])');
    (event.key==='ArrowUp'?items?.[items.length-1]:items?.[0])?.focus();
  }
}
</script>

<template>
  <div ref="root" class="project-actions">
    <div class="project-actions-heading">{{ scopeLabel||'Assign to project' }}</div>
    <label class="project-actions-search">
      <Search :size="14" aria-hidden="true" />
      <input v-model="query" type="search" placeholder="Search projects…" aria-label="Search projects" @keydown="searchKey" @pointerdown.stop @click.stop />
    </label>
    <div class="project-actions-list">
      <component :is="item" class="project-actions-item" :disabled="busy" text-value="Unassigned" @select="emit('assign',null)">
        <span>Unassigned</span><Check v-if="currentProject===null" :size="14" aria-hidden="true" />
      </component>
      <component :is="item" v-for="project in projects" :key="project" class="project-actions-item" :disabled="busy" :text-value="project" :title="project" @select="emit('assign',project)">
        <span class="project-actions-project"><span>{{ name(project) }}</span><small v-if="name(project)!==project">{{ project }}</small></span>
        <Check v-if="currentProject===project" :size="14" aria-hidden="true" />
      </component>
      <p v-if="!projects.length" class="project-actions-empty">{{ query?'No matching projects':'No projects yet' }}</p>
    </div>
    <template v-if="canInspect">
      <div class="project-actions-divider" role="separator" />
      <component :is="item" class="project-actions-item" :disabled="busy" @select="emit('inspect')">Details, split &amp; rules</component>
    </template>
  </div>
</template>

<style scoped>
.project-actions{width:min(300px,calc(100vw - 32px));padding:5px;color:var(--text);background:var(--panel-raised);border:1px solid var(--border);border-radius:var(--radius-inner);box-shadow:0 12px 36px #0003;font-size:var(--text-sm)}
.project-actions-heading{padding:6px 8px;color:var(--muted);font-size:var(--text-xs);font-weight:600}
.project-actions-search{display:flex;align-items:center;gap:7px;margin:2px 4px 6px;padding:6px 8px;border:1px solid var(--border);border-radius:var(--radius-thumb);color:var(--muted)}
.project-actions-search:focus-within{border-color:var(--accent)}
.project-actions-search input{width:100%;min-width:0;padding:0;border:0;outline:0;background:transparent;color:var(--text);font:inherit}
.project-actions-list{max-height:min(300px,45vh);overflow-y:auto}
.project-actions-item{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:34px;padding:6px 8px;border-radius:6px;outline:0;cursor:default;user-select:none}
.project-actions-item[data-highlighted]{background:var(--accent-soft);color:var(--accent-text)}
.project-actions-item[data-disabled]{opacity:.45;pointer-events:none}
.project-actions-project{display:flex;flex-direction:column;min-width:0;gap:2px}
.project-actions-project span,.project-actions-project small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.project-actions-project small{font-size:var(--text-xs);color:var(--muted)}
.project-actions-divider{height:1px;margin:5px;background:var(--border)}
.project-actions-empty{margin:10px 8px;color:var(--muted);font-size:var(--text-xs)}
</style>
