<script setup lang="ts">
import AppButton from './AppButton.vue';
import AppCard from './AppCard.vue';
import {startBackgroundActivity,clearCompletedBackgroundActivities} from './background-activity.ts';
import { computed, onMounted, ref } from 'vue';
import {
  storageTransport,
  storageRecoveryTransport,
  type PendingStorage,
  type PreparedStorage,
  type StorageReplacementResult,
} from './transport.ts';
import type { StorageUsage } from '../capture/storage-usage.ts';
import { humanizeError } from './errors.ts';
import { bytes as size } from './format.ts';
import {storageProjection} from './storage-presentation.ts';
import { toast } from './toast.ts';
const props=defineProps<{ running: boolean;limit?:number }>();
const emit=defineEmits<{change:[settings:{storageLimitMB:number}]} >();
function changeBudget(event:Event){const input=event.target as HTMLInputElement,value=Number(input.value);if(Number.isFinite(value)&&value>=1&&value<=1024)emit('change',{storageLimitMB:Math.round(value*1024)});else input.value=String((props.limit??5120)/1024);}
const usage = ref<StorageUsage | null>(null),
  busy = ref(false),
  error = ref('');
const pending = ref<PendingStorage | null>(null),
  prepared = ref<PreparedStorage | null>(null);
const lastResult = ref<StorageReplacementResult | null>(null);
// What a person recognizes, not how SQLite lays it out: database files are one "history".
const parts = computed(() => {
  const u = usage.value;
  if (!u) return [];
  return [
    { name: 'Your history', detail: 'Recorded activity, sessions and reviews', bytes: u.database.bytes + u.wal.bytes + u.sharedMemory.bytes, color: 'var(--agent-chart)' },
    { name: 'Backups', detail: 'Copies kept from earlier storage upgrades', bytes: u.exports.bytes, color: 'var(--human-chart)' },
    { name: 'Agent connections', detail: 'Hook helpers and events waiting to be saved', bytes: u.runtimes.bytes + u.spool.bytes, color: 'var(--status-good)' },
  ];
});
const budgetBytes = computed(() => ((props.limit ?? usage.value?.storageLimitMB ?? 5120) * 1024 * 1024));
const scale = computed(() => Math.max(budgetBytes.value, usage.value?.totalBytes || 0, 1));
const overBudget = computed(() => (usage.value?.totalBytes || 0) > budgetBytes.value);
const diskLow = computed(() => usage.value?.freeBytes !== null && usage.value?.freeBytes !== undefined && usage.value.freeBytes < 2 * 1024 ** 3);
const forecast=computed(()=>storageProjection(usage.value?.byDay||[],usage.value?.history));
async function refresh() {
  busy.value = true;
  error.value = '';
  try {
    [usage.value, pending.value, lastResult.value] = await Promise.all([
      storageTransport.usage(),
      storageRecoveryTransport.pending(),
      storageRecoveryTransport.result(),
    ]);
  } catch (cause) {
    error.value = humanizeError(cause);
  } finally {
    busy.value = false;
  }
}
async function reclaim() {
  busy.value = true;
  error.value = '';
  try {
    const before = usage.value?.wal.bytes || 0;
    usage.value = await storageTransport.reclaim();
    toast.success(`Reclaimed ${size(Math.max(0, before - usage.value.wal.bytes))} of temporary space.`);
  } catch (cause) {
    error.value = humanizeError(cause);
  } finally {
    busy.value = false;
  }
}
async function compact() {
  busy.value = true;
  error.value = '';
  const activity=startBackgroundActivity('Optimizing history…','storage');
  try {
    prepared.value = await storageRecoveryTransport.prepare();
    pending.value = await storageRecoveryTransport.pending();
    usage.value = await storageTransport.usage();
    toast.success('Optimized copy verified. Quit and reopen Agent Time to apply it.');
    activity.finish('Optimized history ready for restart');
  } catch (cause) {
    activity.finish();
    error.value = humanizeError(cause);
  } finally {
    busy.value = false;
  }
}
async function cancel() {
  busy.value = true;
  error.value = '';
  try {
    await storageRecoveryTransport.cancel();
    clearCompletedBackgroundActivities('storage');
    pending.value = null;
    prepared.value = null;
    usage.value = await storageTransport.usage();
    toast.success('Pending replacement cancelled. Current data is kept.');
  } catch (cause) {
    error.value = humanizeError(cause);
  } finally {
    busy.value = false;
  }
}
onMounted(() => {
  void refresh();
});
</script>
<template>
  <AppCard as="section" padding="regular" class="storage-usage" aria-labelledby="storage-title">
    <div class="storage-head">
      <h3 id="storage-title">Storage</h3>
      <span v-if="usage" class="storage-used">{{ size(usage.totalBytes) }} of {{ size(budgetBytes) }} used</span>
      <AppButton class="btn btn-sm" :disabled="busy" @click="refresh">{{ busy ? 'Measuring…' : 'Refresh' }}</AppButton>
    </div>
    <p v-if="error" role="alert" class="storage-error">{{ error }}</p>
    <template v-if="usage">
      <div class="storage-bar" role="img" :aria-label="`${size(usage.totalBytes)} of ${size(budgetBytes)} used`">
        <span
          v-for="part in parts.filter((item) => item.bytes > 0)"
          :key="part.name"
          :style="{ width: `max(3px, ${(part.bytes / scale) * 100}%)`, background: part.color }"
          :title="`${part.name}: ${size(part.bytes)}`"
        ></span>
      </div>
      <div class="storage-legend">
        <span v-for="part in parts" :key="part.name"><i :style="{ background: part.color }"></i>{{ part.name }}</span>
      </div>

      <p v-if="usage.care?.paused" class="storage-error">
        Capture is paused to stay within your limit. Raise the limit or delete a backup you no longer need.
      </p>
      <p v-else-if="overBudget" class="storage-error">
        Over your limit. Capture pauses if Agent Time cannot compress enough; raise the limit or delete a backup.
      </p>
      <p v-else-if="diskLow" class="storage-error">Your Mac is almost out of space. Capture pauses if less than 1 GB is free.</p>

      <ul class="storage-list">
        <li v-for="part in parts" :key="part.name">
          <i :style="{ background: part.color }"></i>
          <span><strong>{{ part.name }}</strong><small>{{ part.detail }}</small></span>
          <b>{{ size(part.bytes) }}</b>
        </li>
      </ul>

      <label class="storage-limit">
        <span><strong>Storage limit</strong><small>Agent Time compresses older history and never deletes it on its own.</small></span>
        <span><input type="number" min="1" max="1024" step="1" :value="budgetBytes / 1024 ** 3" :disabled="busy" @change="changeBudget" /> GB</span>
      </label>
      <p v-if="forecast.bytes !== null" class="storage-note">At your recent pace, a month of tracking adds about {{ size(forecast.bytes!) }}.</p>
      <p v-if="usage.care?.error" class="storage-error">Storage cleanup could not finish: {{ usage.care.error }}</p>
      <p v-if="lastResult && lastResult.status !== 'applied'" class="storage-note">
        A storage upgrade was cancelled because data changed. Your current data was kept.
      </p>

      <div v-if="!usage.history?.efficient || pending" class="storage-action">
        <template v-if="!pending">
          <span><strong>Save space</strong><small>Compress your history once. Everything is checked before switching, and the original is kept as a backup.</small></span>
          <AppButton class="btn btn-primary" :disabled="busy || running" @click="compact">{{ busy ? 'Preparing…' : 'Save space' }}</AppButton>
          <small v-if="running">Pause capture first.</small>
        </template>
        <template v-else>
          <span><strong>Ready to save {{ prepared ? size(prepared.savingsBytes) : 'space' }}</strong><small>Quit and reopen Agent Time to finish.</small></span>
          <AppButton class="btn" :disabled="busy" @click="cancel">Cancel</AppButton>
        </template>
      </div>
      <div v-else-if="usage.wal.bytes > 64 * 1024 * 1024" class="storage-action">
        <span><strong>Free temporary space</strong><small>{{ size(usage.wal.bytes) }} can be released without losing anything.</small></span>
        <AppButton class="btn" :disabled="busy" @click="reclaim">Free up</AppButton>
      </div>
    </template>
  </AppCard>
</template>
<style scoped>
.storage-usage { margin-top: 16px; font-size: var(--text-sm); }
.storage-head { display: flex; align-items: center; gap: 12px; }
.storage-head h3 { margin: 0; font-size: var(--text-md); }
.storage-used { margin-left: auto; color: var(--muted); font-variant-numeric: tabular-nums; }
.storage-bar { display: flex; gap: 2px; height: 22px; margin: 14px 0 8px; padding: 0; overflow: hidden; border-radius: 6px; background: var(--hover); }
.storage-bar span { height: 100%; }
.storage-legend { display: flex; flex-wrap: wrap; gap: 6px 16px; color: var(--muted); font-size: var(--text-xs); }
.storage-legend span { display: inline-flex; align-items: center; gap: 6px; }
.storage-legend i, .storage-list i { width: 9px; height: 9px; flex: none; border-radius: 50%; }
.storage-list { margin: 16px 0 0; padding: 0; list-style: none; }
.storage-list li, .storage-limit, .storage-action { display: flex; align-items: center; gap: 12px; padding: 11px 0; border-top: 1px solid var(--border); }
.storage-list li > span, .storage-limit > span:first-child, .storage-action > span { flex: 1; min-width: 0; }
.storage-list strong, .storage-limit strong, .storage-action strong { display: block; font-weight: 550; }
.storage-list small, .storage-limit small, .storage-action small { display: block; margin-top: 2px; color: var(--muted); font-size: var(--text-xs); }
.storage-list b { font-weight: 500; font-variant-numeric: tabular-nums; }
.storage-limit input { width: 64px; margin-right: 4px; padding: var(--control-padding-block) var(--control-padding-inline); color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 5px; }
.storage-note { margin: 4px 0 8px; color: var(--muted); font-size: var(--text-xs); }
.storage-error { margin: 12px 0 0; color: var(--status-danger); }
</style>
