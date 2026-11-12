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
    <div class="loading-title"><strong>{{ label }}</strong><span aria-hidden="true">{{ elapsedLabel }}</span></div>
    <progress :value="total ? completed : undefined" :max="total || undefined" :aria-label="label" />
    <p v-if="detail">{{ detail }}</p>
  </div>
</template>
<style scoped>
.loading-status { padding: 14px 16px; border: 1px solid var(--border); border-radius: 10px; background: var(--panel); margin: 12px 0; }
.loading-title { display: flex; justify-content: space-between; gap: 16px; font-size: 12px; }
.loading-title span, p { color: var(--muted); font-size: 12px; }
progress { display: block; width: 100%; height: 5px; margin: 10px 0; accent-color: var(--accent); }
p { margin: 0; line-height: 1.5; }
</style>
