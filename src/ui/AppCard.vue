<script setup lang="ts">
withDefaults(defineProps<{
  as?: 'div' | 'section' | 'article' | 'form';
  padding?: 'none' | 'compact' | 'regular' | 'spacious';
}>(), { as: 'div', padding: 'none' });
</script>

<template>
  <component :is="as" :class="['app-card', `app-card--${padding}`]"><slot /></component>
</template>

<style scoped>
.app-card {
  min-width: 0;
  border: 1px solid var(--app-card-border, var(--border));
  border-radius: var(--app-card-radius, var(--radius-lg, 16px));
  background: var(--panel);
  padding: var(--app-card-padding, 0);
}
.app-card--none { --app-card-padding: 0; }
.app-card--compact { --app-card-padding: 16px; }
.app-card--regular { --app-card-padding: 20px; }
.app-card--spacious { --app-card-padding: 24px; }
</style>
