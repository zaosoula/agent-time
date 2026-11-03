<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import {
  checkBetaUpdate,
  installBetaUpdate,
  progressLabel,
  tauriUpdaterBridge,
  type BetaUpdateInfo,
  type BetaUpdateProgress,
} from './beta-updates.ts';
import { humanizeError } from './errors.ts';
import { native } from './transport.ts';

const update = ref<BetaUpdateInfo | null>(null),
  error = ref(''),
  checking = ref(false),
  installing = ref(false),
  progress = ref<BetaUpdateProgress | null>(null);
let unlistenAvailable: (() => void) | undefined,
  unmounted = false,
  lastCheck = 0;

async function checkNow() {
  if (!native || checking.value || installing.value) return;
  lastCheck = Date.now();
  checking.value = true;
  error.value = '';
  try {
    update.value = await checkBetaUpdate(await tauriUpdaterBridge());
  } catch (cause) {
    error.value = humanizeError(cause);
  } finally {
    checking.value = false;
  }
}

async function install() {
  if (!update.value || installing.value) return;
  installing.value = true;
  error.value = '';
  progress.value = null;
  try {
    // On success the host restarts Agent Time, so nothing after this normally runs.
    await installBetaUpdate(await tauriUpdaterBridge(), (next) => {
      progress.value = next;
    });
  } catch (cause) {
    error.value = `Update failed: ${humanizeError(cause)} Capture continues normally.`;
    installing.value = false;
    progress.value = null;
  }
}

function checkOnReturn() {
  if (document.visibilityState === 'visible' && Date.now() - lastCheck > 3_600_000) void checkNow();
}

onMounted(async () => {
  void checkNow();
  window.addEventListener('focus', checkOnReturn);
  document.addEventListener('visibilitychange', checkOnReturn);
  if (!native) return;
  const { listen } = await import('@tauri-apps/api/event');
  const dispose = await listen('update-available', () => void checkNow());
  if (unmounted) dispose();
  else unlistenAvailable = dispose;
});
onUnmounted(() => {
  unmounted = true;
  unlistenAvailable?.();
  window.removeEventListener('focus', checkOnReturn);
  document.removeEventListener('visibilitychange', checkOnReturn);
});
</script>

<template>
  <div v-if="update || error" class="beta-update" role="status">
    <template v-if="update">
      <strong>Agent Time {{ update.version }} is available</strong>
      <span>{{ update.body || `You have ${update.currentVersion}. A beta update is ready.` }}</span>
      <button class="btn btn-primary" :disabled="installing" @click="install">
        {{ installing ? progressLabel(progress) : 'Install and restart' }}
      </button>
      <span v-if="error" class="beta-update-error" role="alert">{{ error }}</span>
    </template>
    <template v-else>
      <span>Update check unavailable. Capture continues normally.</span>
      <button class="btn" :disabled="checking" @click="checkNow">Retry</button>
      <details class="beta-update-error">
        <summary>Details</summary>
        {{ error }}
      </details>
    </template>
  </div>
</template>

<style scoped>
.beta-update {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
  padding: var(--space-3) var(--space-5);
  background: var(--panel);
  border-bottom: 1px solid var(--border);
  font-size: var(--text-sm);
}
.beta-update span {
  flex: 1;
  min-width: 180px;
  color: var(--muted);
}
.beta-update-error {
  flex-basis: 100%;
  color: var(--muted);
  font-size: var(--text-xs);
}
</style>
