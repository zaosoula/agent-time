<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
defineProps<{ label: string; detail?: string; completed?: number; total?: number }>();
const started = Date.now(), elapsed = ref(0);
const elapsedLabel = computed(() => elapsed.value < 60 ? `${elapsed.value}s` : `${Math.floor(elapsed.value / 60)}m ${elapsed.value % 60}s`);
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => { timer = setInterval(() => { elapsed.value = Math.floor((Date.now() - started) / 1000); }, 1000); });
onUnmounted(() => clearInterval(timer));
</script>
<template>
  <div class="loading-status" role="status" aria-live="polite">
    <div class="loading-title">
      <strong>{{ label }}</strong>
      <progress :value="total ? completed : undefined" :max="total || undefined" :aria-label="label" />
      <span aria-hidden="true">{{ elapsedLabel }}</span>
    </div>
    <p v-if="detail">{{ detail }}</p>
  </div>
</template>
<style scoped>
.loading-status { padding: 12px 0; margin: 12px 0; }
.loading-title { display: flex; align-items: center; gap: 12px; font-size: var(--text-caption, 13px); }
.loading-title strong { font-weight: 500; }
.loading-title span { margin-left: auto; flex: none; color: var(--muted); font-variant-numeric: tabular-nums; }
progress { flex: 1; min-width: 40px; max-width: 160px; height: 4px; accent-color: var(--accent); }
p { margin: 6px 0 0; color: var(--muted); font-size: var(--text-caption, 13px); line-height: 1.45; }
@media (max-width: 480px) { .loading-title { flex-wrap: wrap; } progress { max-width: 80px; } }
</style>
