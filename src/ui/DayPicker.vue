<script setup lang="ts">
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
    <button
      class="icon-button"
      aria-label="Previous day"
      @click="store.setDate(shiftDate(store.selectedDate, -1))"
    >
      <ChevronLeft :size="16" />
    </button>
    <input
      type="date"
      aria-label="Choose day"
      required
      :value="store.selectedDate"
      @change="onInput"
      @blur="onInput"
    />
    <button
      class="icon-button"
      aria-label="Next day"
      @click="store.setDate(shiftDate(store.selectedDate, 1))"
    >
      <ChevronRight :size="16" />
    </button>
    <button
      class="btn btn-sm"
      :disabled="store.isToday"
      @click="store.setDate(dateString(new Date()))"
    >
      Today
    </button>
  </div>
</template>
