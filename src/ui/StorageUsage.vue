<script setup lang="ts">
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
import { bytes as size, count } from './format.ts';
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
const rows = computed(() =>
  usage.value
    ? [
        { name: 'Event database', value: usage.value.database },
        { name: 'SQLite write-ahead log', value: usage.value.wal },
        { name: 'SQLite shared memory', value: usage.value.sharedMemory },
        { name: 'Pending hook events', value: usage.value.spool },
        { name: 'Generated hook runtimes', value: usage.value.runtimes },
        { name: 'Local archives', value: usage.value.exports },
      ]
    : [],
);
const recent = computed(() => {
  const days = new Map<string, { events: number; bytes: number }>();
  for (const row of usage.value?.byDay || []) {
    const day = days.get(row.date) || { events: 0, bytes: 0 };
    day.events += row.events;
    day.bytes += row.payloadBytes;
    days.set(row.date, day);
  }
  return [...days].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 7);
});
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
  try {
    prepared.value = await storageRecoveryTransport.prepare();
    pending.value = await storageRecoveryTransport.pending();
    usage.value = await storageTransport.usage();
    toast.success('Optimized copy verified. Quit and reopen Agent Time to apply it.');
  } catch (cause) {
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
  <section class="storage-usage card" aria-labelledby="storage-title">
    <div class="storage-head">
      <div>
        <h3 id="storage-title">Storage</h3>
        <p>See what Agent Time keeps on this Mac. Index space is part of the database size.</p>
      </div>
      <button class="btn btn-sm" :disabled="busy" @click="refresh">
        {{ busy ? 'Measuring…' : 'Refresh' }}
      </button>
    </div>
    <p v-if="error" role="alert" class="storage-error">{{ error }}</p>
    <template v-if="usage">
      <strong class="storage-total"
        >{{ size(usage.totalBytes) }} total · {{ count(usage.eventCount) }} events</strong
      >
      <p v-if="usage.freeBytes !== null">
        {{ size(usage.freeBytes) }} available on this disk.<span
          v-if="usage.freeBytes < Math.max(usage.database.bytes,(usage.history?.originalBytes||0)+(usage.history?.hotBytes||0)) * 3 + 1024 * 1024 * 1024"
          class="storage-error"
        >
          A verified compacted copy needs at least {{ size(Math.max(usage.database.bytes,(usage.history?.originalBytes||0)+(usage.history?.hotBytes||0)) * 3 + 1024 * 1024 * 1024) }} free;
          clear space before preparing it.</span
        >
      </p>
      <div class="storage-action" role="status">
        <strong>{{ usage.history?.efficient ? 'Automatic storage care is on' : 'Optimize history to enable automatic storage care' }}</strong>
        <p v-if="usage.history?.efficient">All original timestamps and review decisions are kept. Older events share compressed records; recent data is kept ready for capture.</p>
        <p v-else>Prepare an optimized copy below to reduce storage while keeping every remaining event and the same timing calculations.</p>
        <p v-if="usage.history?.coldEvents">{{ count(usage.history.coldEvents) }} events use {{ size(usage.history.compressedBytes) }} of compressed payload, saving {{ size(Math.max(0,usage.history.originalBytes-usage.history.compressedBytes)) }}. Recent uncompressed payload: {{ size(usage.history.hotBytes) }}. Event references and indexes are included in the database size above.</p>
        <label>Storage budget <input type="number" min="1" max="1024" step="1" :value="(limit??usage.storageLimitMB??5120)/1024" :disabled="busy" @change="changeBudget" /> GB</label>
        <p>Includes the database, archives, hook runtimes and pending events. Agent Time compresses history and keeps 1 GB free on disk. Capture pauses if it cannot stay within your budget. Unique history is never deleted automatically.</p>
        <p v-if="usage.care?.paused" class="storage-error">Capture is paused for storage. Free disk space, increase the budget, or remove a backup you no longer need, then start capture.</p>
        <p v-if="usage.care?.error" class="storage-error">Storage care could not finish: {{ usage.care.error }}</p>
        <p v-else-if="usage.care?.at">Last storage care: {{ new Date(usage.care.at*1000).toLocaleString() }}.</p>
      </div>
      <p v-if="lastResult" role="status">
        {{
          lastResult.status === 'applied'
            ? 'Storage replacement completed. The prior database remains in Local archives as ' +
              lastResult.backup +
              '. Review capture before choosing whether to delete it.'
            : 'Storage replacement was cancelled because data changed or the prior swap was interrupted. The current database was kept.'
        }}
      </p>
      <dl>
        <div v-for="row in rows" :key="row.name">
          <dt>{{ row.name }}</dt>
          <dd>{{ size(row.value.bytes) }}<small v-if="row.value.truncated"> · partial scan</small></dd>
        </div>
      </dl>
      <p>
        Database indexes occupy about {{ size(usage.indexes.bytes) }} within the event database. Recent
        captured payload, excluding database and index overhead:
      </p>
      <ul>
        <li v-for="[date, day] in recent" :key="date">
          <span>{{ date }}</span
          ><span>{{ count(day.events) }} events · {{ size(day.bytes) }}</span>
        </li>
      </ul>
      <p v-if="!recent.length">No events recorded in the last 30 days.</p>
      <p v-if="forecast.bytes !== null">
        At the recent rate, another 30 tracked days would add about {{ size(forecast.bytes!) }} of {{ forecast.compressed ? 'compressed' : 'uncompressed' }} payload, before event references and index overhead. This estimate uses {{ forecast.compressed ? 'your measured compression rate' : 'captured payload sizes' }}.
      </p>
      <div v-if="usage.wal.bytes > 0" class="storage-action">
        <p>
          Reclaim the SQLite write-ahead log after saved events are checkpointed. This keeps all observations
          and review decisions.
        </p>
        <button class="btn" :disabled="busy" @click="reclaim">
          Reclaim {{ size(usage.wal.bytes) }} of temporary space
        </button>
      </div>
      <div class="storage-action">
        <p>
          Create a verified optimized copy. Every event ID, timestamp, payload and review decision is checked before replacement on the next launch. The original stays as a compressed recovery archive. Older connected agent tools may need to reconnect after this one-time upgrade.
        </p>
        <button v-if="!pending" class="btn btn-primary" :disabled="busy || running" @click="compact">
          {{ busy ? 'Verifying copy…' : 'Prepare optimized database' }}
        </button>
        <small v-if="running">Pause capture before preparing space recovery.</small>
        <template v-if="pending"
          ><strong
            >{{ pending.kind === 'compaction' ? 'Optimized database' : 'Archive replacement' }} ready for the
            next launch</strong
          >
          <p v-if="prepared">
            Live database reduction: {{ size(prepared.savingsBytes) }}. Events:
            {{ count(prepared.beforeRows) }} → {{ count(prepared.afterRows) }}. The rollback archive will also
            use disk space.
          </p>
          <p>
            Quit Agent Time completely, then reopen it to apply. If the source changes first, replacement is
            cancelled and current data remains in place.
          </p>
          <button class="btn" :disabled="busy" @click="cancel">Cancel pending replacement</button></template
        >
      </div>
    </template>
  </section>
</template>
<style scoped>
.storage-usage {
  margin-top: 16px;
  padding: 19px 20px;
  font-size: var(--text-sm);
}
.storage-head {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 16px;
}
.storage-head h3 {
  font-size: var(--text-md);
  margin: 0 0 6px;
}
.storage-usage p {
  color: var(--muted);
  line-height: 1.5;
  margin: 6px 0 12px;
}
.storage-action input {width: 90px; margin: 0 6px; padding: 5px; color: var(--text); background: var(--surface); border: 1px solid var(--border); border-radius: 5px;}
.storage-total {
  display: block;
  font-size: var(--text-md);
  margin: 12px 0;
}
.storage-usage dl {
  margin: 0;
}
.storage-usage dl div,
.storage-usage li {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 0;
  border-top: 1px solid var(--border);
}
.storage-usage dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
}
.storage-usage ul {
  padding: 0;
  margin: 0;
  list-style: none;
}
.storage-error {
  color: var(--status-danger) !important;
}
.storage-action {
  border-top: 1px solid var(--border);
  padding-top: 10px;
}
</style>
