<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { native } from './transport.ts';
import { humanizeError } from './errors.ts';

const version = ref('Development preview'), checking = ref(false), error = ref('');
onMounted(async () => {
  if (!native) return;
  try { version.value = await (await import('@tauri-apps/api/app')).getVersion(); }
  catch (cause) { error.value = humanizeError(cause); }
});
async function checkUpdates() {
  if (!native || checking.value) return;
  checking.value = true;
  error.value = '';
  try {
    // The global updater owns checks, installation and progress even after leaving Settings.
    await (await import('@tauri-apps/api/event')).emit('check-updates', version.value);
  } catch (cause) { error.value = humanizeError(cause); }
  finally { checking.value = false; }
}
</script>
<template>
  <section class="settings-about" aria-labelledby="about-title">
    <h3 id="about-title">About Agent Time</h3>
    <p>Version {{ version }} · Time and activity captured on this Mac.</p>
    <button class="btn" :disabled="!native || checking" @click="checkUpdates">
      {{ checking ? 'Checking…' : 'Check for updates' }}
    </button>
    <p v-if="!native">Updates are available in the packaged Mac app.</p>
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>
<style scoped>
.settings-about { margin-top: 28px; }
h3 { font-size: 14px; }
p { color: var(--muted); font-size: 12px; line-height: 1.6; }
[role='alert'] { color: var(--status-danger); }
</style>
