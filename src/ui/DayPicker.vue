<script setup lang="ts">
import AppButton from './AppButton.vue';
import { reactive } from 'vue';
import { ChevronLeft, ChevronRight } from '@lucide/vue';
import { useStore } from './store.ts';
import { dateString, shiftDate } from './format.ts';

const store = reactive(useStore());

function onInput(event: Event) {
  const input = event.target as HTMLInputElement;
  // Clearing the field or typing a partial date leaves the selected day unchanged.
  if (!store.setDate(input.value)) input.value = store.selectedDate;
}
</script>

<template>
  <div class="date-controls">
    <AppButton compact variant="quiet"
      class="icon-button"
      aria-label="Previous day"
      @click="store.setDate(shiftDate(store.selectedDate, -1))"
    >
      <ChevronLeft :size="16" />
    </AppButton>
    <input
      type="date"
      class="control-compact"
      aria-label="Choose day"
      required
      :value="store.selectedDate"
      @change="onInput"
      @blur="onInput"
    />
    <AppButton compact variant="quiet"
      class="icon-button"
      aria-label="Next day"
      @click="store.setDate(shiftDate(store.selectedDate, 1))"
    >
      <ChevronRight :size="16" />
    </AppButton>
    <AppButton compact
      :disabled="store.isToday"
      @click="store.setDate(dateString(new Date()))"
    >
      Today
    </AppButton>
  </div>
</template>
