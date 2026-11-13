<script setup lang="ts">
import { Sun, Moon, Monitor } from '@lucide/vue';
import { RadioGroupRoot, RadioGroupItem } from 'reka-ui';
import { appearance } from './appearance.ts';
const modes = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];
</script>

<template>
  <RadioGroupRoot v-model="appearance" orientation="horizontal" aria-label="Appearance" class="appearance-control">
    <RadioGroupItem v-for="mode in modes" :key="mode.value" :value="mode.value" class="appearance-choice">
      <component :is="mode.icon" :size="14" aria-hidden="true" /><span>{{ mode.label }}</span>
    </RadioGroupItem>
  </RadioGroupRoot>
</template>

<style scoped>
.appearance-control{display:flex;gap:2px;padding:3px;border-radius:var(--radius-pill);background:var(--hover);width:100%;max-width:300px}
.appearance-choice{display:flex;align-items:center;justify-content:center;flex:1;gap:5px;min-height:32px;padding:4px 7px;border-radius:var(--radius-pill);color:var(--muted);font-size:var(--text-sm);cursor:pointer}
.appearance-choice[data-state=checked]{background:var(--text);color:var(--bg);font-weight:600}
.appearance-choice:hover:not([data-state=checked]){color:var(--text)}
</style>
