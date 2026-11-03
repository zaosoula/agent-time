<script setup lang="ts">
import { ref } from 'vue';
import {
  DialogRoot,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from 'reka-ui';
import { transport } from './transport.ts';
import type { TrackingCleanupPreview } from '../capture/hook-installation.ts';
import { humanizeError } from './errors.ts';
import { toast } from './toast.ts';
const open = ref(false),
  busy = ref(false),
  preview = ref<TrackingCleanupPreview | null>(null),
  error = ref(''),
  message = ref('');
async function review() {
  busy.value = true;
  error.value = '';
  message.value = '';
  try {
    preview.value = await transport.cleanupPreview();
    open.value = true;
  } catch (e) {
    error.value = humanizeError(e);
  } finally {
    busy.value = false;
  }
}
async function remove() {
  busy.value = true;
  error.value = '';
  try {
    const result = await transport.cleanupTracking();
    message.value = `Removed Agent Time hooks from ${result.removedConfigurations.length} configurations and ${result.removedHelpers.length} helper runtimes. Restart existing agent sessions to unload their hooks.`;
    if (result.errors.length) {
      error.value = result.errors.join('\n');
      preview.value = await transport.cleanupPreview();
    } else {
      open.value = false;
      toast.success('Agent Time tracking tools removed.');
    }
  } catch (e) {
    error.value = humanizeError(e);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div class="danger-zone">
    <h3>Remove tracking tools</h3>
    <p>
      Remove Agent Time hooks and installed tracking helpers from your user, Orca account and recorded project
      configurations. Hooks from other tools and your timesheet history are kept.
    </p>
    <button class="btn btn-danger" :disabled="busy" @click="review">
      {{ busy ? 'Checking…' : 'Review installed tracking tools…' }}
    </button>
    <p v-if="message" role="status">{{ message }}</p>
    <p v-if="error && !open" class="error" role="alert">{{ error }}</p>
  </div>
  <DialogRoot :open="open" @update:open="!busy && (open = $event)"
    ><DialogPortal
      ><DialogOverlay class="cleanup-overlay" /><DialogContent
        class="cleanup-dialog"
        @escape-key-down="busy && $event.preventDefault()"
        @pointer-down-outside="busy && $event.preventDefault()"
        ><DialogTitle class="title">Remove installed tracking tools?</DialogTitle
        ><DialogDescription class="description"
          >This removes only Agent Time’s hooks and helper runtimes. Your captured history, capture
          preferences and other tools’ hooks are kept. You can reinstall using hook setup.</DialogDescription
        >
        <div class="preview">
          <h4>Configurations with Agent Time hooks · {{ preview?.configurations.length || 0 }}</h4>
          <code v-for="path in preview?.configurations" :key="path">{{ path }}</code>
          <h4>Installed helper runtimes · {{ preview?.helpers.length || 0 }}</h4>
          <code v-for="path in preview?.helpers" :key="path">{{ path }}</code>
          <p v-if="!preview?.configurations.length && !preview?.helpers.length">
            No installed tools to remove.
          </p>
          <p v-for="issue in preview?.errors" :key="issue" class="error">{{ issue }}</p>
        </div>
        <p class="description">
          Existing agent sessions may keep hooks in memory. Restart them after removal. Orca discovery and
          macOS activity continue according to your capture settings.
        </p>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <div class="actions">
          <button class="btn" :disabled="busy" @click="open = false">Cancel</button
          ><button
            class="btn btn-danger"
            :disabled="busy || (!preview?.configurations.length && !preview?.helpers.length)"
            @click="remove"
          >
            {{ busy ? 'Removing…' : 'Remove Agent Time tools' }}
          </button>
        </div>
      </DialogContent></DialogPortal
    ></DialogRoot
  >
</template>
<style scoped>
.danger-zone {
  margin-top: 0;
  padding: 20px;
  border: 1px solid color-mix(in srgb, var(--status-danger) 40%, transparent);
  border-radius: 10px;
  background: var(--panel);
}
h3 {
  font-size: var(--text-md);
  margin: 0 0 8px;
}
.danger-zone p,
.description {
  font-size: 12px;
  line-height: 1.6;
  color: var(--muted);
  margin: 10px 0;
}
.cleanup-overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  background: #0006;
  backdrop-filter: blur(3px);
}
.cleanup-dialog {
  position: fixed;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: min(560px, calc(100vw - 48px));
  max-height: 85vh;
  overflow: auto;
  padding: 26px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--panel);
  color: var(--text);
  z-index: 101;
  box-shadow: 0 18px 65px #0005;
}
.title {
  font-size: var(--text-xl);
  font-weight: 600;
}
.preview {
  margin: 18px 0;
  padding: 14px;
  background: var(--hover);
  border-radius: 8px;
  max-height: 230px;
  overflow: auto;
}
.preview h4 {
  font-size: 12px;
  margin: 8px 0;
}
.preview code {
  font-size: var(--text-xs);
  display: block;
  overflow-wrap: anywhere;
  margin-bottom: 8px;
}
.preview p {
  font-size: 12px;
}
.error {
  color: var(--status-danger) !important;
  font-size: 12px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 20px;
}
</style>
