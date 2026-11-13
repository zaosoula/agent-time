<script setup lang="ts">
import {useRetainedOpen} from './page-presentation.ts';
import { computed, ref, watch } from 'vue';
import {
  ListboxContent,
  ListboxFilter,
  ListboxItem,
  ListboxRoot,
  PopoverContent,
  PopoverPortal,
  PopoverRoot,
  PopoverTrigger,
} from 'reka-ui';
import { ChevronsUpDown } from '@lucide/vue';

const props = defineProps<{ paths: string[]; modelValue: string; label: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();

const query = ref(''),
  open = ref(false);
const basename = (path: string) => path.split('/').filter(Boolean).at(-1) || path;
const typedPath = computed(() => {
  const value = query.value.trim();
  return value.startsWith('/') && !props.paths.includes(value) ? value : '';
});
const matches = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase();
  return props.paths
    .filter((path) => !needle || `${basename(path)} ${path}`.toLocaleLowerCase().includes(needle))
    .slice(0, 80);
});

watch(open, (value) => {
  if (!value) query.value = '';
});

function choose(value: unknown) {
  if (typeof value !== 'string' || !value) return;
  emit('update:modelValue', value);
  open.value = false;
}
const presentedOpen = useRetainedOpen(open);
</script>

<template>
  <div class="project-picker">
    <PopoverRoot v-model:open="presentedOpen">
      <PopoverTrigger as-child>
        <button type="button" class="project-picker-current" :aria-label="label" aria-haspopup="listbox">
          <span class="project-picker-value">
            {{ modelValue ? basename(modelValue) : 'Choose project' }}
            <small v-if="modelValue" :title="modelValue">{{ modelValue }}</small>
          </span>
          <ChevronsUpDown :size="13" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverPortal>
        <PopoverContent
          class="project-picker-menu"
          side="bottom"
          align="start"
          :side-offset="4"
          :collision-padding="8"
        >
          <ListboxRoot
            :model-value="modelValue || undefined"
            selection-behavior="replace"
            highlight-on-hover
            @update:model-value="choose"
          >
            <ListboxFilter
              v-model="query"
              auto-focus
              class="project-picker-search"
              :aria-label="`Search ${label.toLowerCase()}`"
              placeholder="Search project or enter /folder/path"
            />
            <ListboxContent class="project-picker-results" :aria-label="label">
              <ListboxItem v-for="path in matches" :key="path" :value="path" class="project-picker-option">
                <strong>{{ basename(path) }}</strong
                ><small>{{ path }}</small>
              </ListboxItem>
              <ListboxItem v-if="typedPath" :value="typedPath" class="project-picker-option">
                <strong>Use this folder</strong><small>{{ typedPath }}</small>
              </ListboxItem>
            </ListboxContent>
            <p v-if="!matches.length && !typedPath" class="project-picker-empty">
              No matching project. Type an absolute folder path, or work in a project folder so it is
              discovered.
            </p>
          </ListboxRoot>
        </PopoverContent>
      </PopoverPortal>
    </PopoverRoot>
  </div>
</template>

<style scoped>
.project-picker {
  position: relative;
  min-width: 200px;
  flex: 1 1 220px;
}
.project-picker-current {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: var(--control-height);
  padding: var(--control-padding-block) var(--control-padding-inline);
  border: 1px solid var(--border);
  border-radius: var(--control-radius);
  background: var(--hover);
  color: var(--text);
  text-align: left;
  font-size: var(--control-font-size);
  line-height: var(--control-line-height);
}
.project-picker-current > svg {
  flex: none;
  margin-left: auto;
  color: var(--muted);
}
.project-picker-value {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.project-picker-current small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
  font-size: var(--text-xs);
}
</style>

<style>
/* Portaled outside the component, so these styles are global but namespaced. */
.project-picker-menu {
  z-index: 70;
  width: max(var(--reka-popover-trigger-width), 300px);
  max-width: min(440px, calc(100vw - 16px));
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--panel-raised);
  box-shadow: var(--shadow-popover);
  color: var(--text);
}
.project-picker-search {
  box-sizing: border-box;
  width: 100%;
  padding: var(--control-padding-block) var(--control-padding-inline);
  border: 1px solid var(--border);
  border-radius: var(--control-radius);
  background: var(--hover);
  color: var(--text);
  font: inherit;
  font-size: var(--control-font-size);
  line-height: var(--control-line-height);
}
.project-picker-search:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 0;
}
.project-picker-results {
  max-height: 240px;
  margin-top: 4px;
  overflow: auto;
}
.project-picker-option {
  display: block;
  padding: var(--control-padding-block) var(--control-padding-inline);
  border-radius: var(--control-radius);
  font-size: var(--control-font-size);
  line-height: var(--control-line-height);
  cursor: pointer;
}
.project-picker-option[data-highlighted] {
  background: var(--accent-soft);
}
.project-picker-option[data-state='checked'] strong::after {
  content: ' ✓';
  color: var(--accent);
}
.project-picker-option strong,
.project-picker-option small {
  display: block;
}
.project-picker-option small {
  overflow-wrap: anywhere;
  color: var(--muted);
  font-size: var(--text-xs);
}
.project-picker-empty {
  margin: 0;
  padding: 8px;
  color: var(--muted);
  font-size: var(--text-xs);
  line-height: 1.5;
}
</style>
