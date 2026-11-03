<script setup lang="ts">
import { CheckCircle2, CircleAlert, Info, X } from '@lucide/vue';
import { dismissToast, toasts } from './toast.ts';
</script>

<template>
  <div class="toast-region" aria-label="Notifications">
    <TransitionGroup name="toast">
      <div
        v-for="item in toasts"
        :key="item.id"
        class="toast"
        :class="item.kind"
        :role="item.kind === 'error' ? 'alert' : 'status'"
      >
        <CheckCircle2 v-if="item.kind === 'success'" :size="16" />
        <CircleAlert v-else-if="item.kind === 'error'" :size="16" />
        <Info v-else :size="16" />
        <span>{{ item.message }}</span>
        <button class="toast-close" aria-label="Dismiss notification" @click="dismissToast(item.id)">
          <X :size="14" />
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-region {
  position: fixed;
  right: var(--space-4);
  bottom: 40px;
  z-index: 60;
  display: grid;
  gap: var(--space-2);
  width: min(380px, calc(100vw - 32px));
  pointer-events: none;
}
.toast {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: 10px 10px 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--panel);
  box-shadow: var(--shadow-popover);
  color: var(--text);
  font-size: var(--text-sm);
  line-height: 1.45;
  pointer-events: auto;
}
.toast > svg {
  flex: none;
  margin-top: 1px;
}
.toast > span {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.toast.success > svg {
  color: var(--status-good);
}
.toast.error {
  border-color: color-mix(in srgb, var(--status-danger) 45%, var(--border));
}
.toast.error > svg {
  color: var(--status-danger);
}
.toast.info > svg {
  color: var(--accent);
}
.toast-close {
  flex: none;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: var(--radius-sm);
  color: var(--muted);
}
.toast-close:hover {
  background: var(--hover);
  color: var(--text);
}
.toast-enter-active,
.toast-leave-active {
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(6px);
}
@media (prefers-reduced-motion: reduce) {
  .toast-enter-active,
  .toast-leave-active {
    transition: none;
  }
}
</style>
