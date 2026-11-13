<script setup lang="ts">
withDefaults(defineProps<{
  variant?: 'default' | 'primary' | 'quiet' | 'danger';
  compact?: boolean;
  type?: 'button' | 'submit' | 'reset';
  disabled?: boolean;
}>(), { variant: 'default', compact: false, type: 'button', disabled: false });
</script>

<template>
  <button
    :type="type"
    :disabled="disabled"
    :class="['btn', 'app-button', { 'btn-sm': compact }, variant !== 'default' && `btn-${variant}`]"
  ><slot /></button>
</template>
