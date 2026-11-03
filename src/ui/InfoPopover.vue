<script setup lang="ts">
import { PopoverArrow, PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui';
import { Info } from '@lucide/vue';

defineProps<{ label: string; size?: number }>();
</script>

<template>
  <PopoverRoot>
    <PopoverTrigger class="info-trigger" :aria-label="label">
      <slot name="trigger"><Info :size="size || 13" /></slot>
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent class="popover" side="bottom" align="start" :side-offset="6" :collision-padding="12">
        <slot />
        <PopoverArrow class="popover-arrow" :width="12" :height="6" />
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>

<style>
.info-trigger {
  display: inline-grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: var(--radius-pill);
  color: var(--muted);
  vertical-align: middle;
}
.info-trigger:hover,
.info-trigger[data-state='open'] {
  background: var(--hover);
  color: var(--text);
}
.popover-arrow {
  fill: var(--panel-raised);
}
.popover h3 {
  margin: 0 0 6px;
  font-size: var(--text-sm);
  font-weight: 650;
}
.popover p {
  margin: 0 0 8px;
  color: var(--muted);
}
.popover p:last-child {
  margin-bottom: 0;
}
.popover dl {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 4px 12px;
  margin: 0 0 8px;
}
.popover dt {
  color: var(--muted);
}
.popover dd {
  margin: 0;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
</style>
