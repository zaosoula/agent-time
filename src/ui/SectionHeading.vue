<script setup lang="ts">
withDefaults(defineProps<{
  as?: 'header' | 'div';
  title?: string;
  description?: string;
  level?: 1 | 2 | 3 | 4;
  size?: 'page' | 'section' | 'compact';
}>(), { as: 'header', level: 2, size: 'section' });
</script>

<template>
  <component :is="as" :class="['section-heading', `section-heading--${size}`, { 'app-page-header': size === 'page' }]">
    <div class="section-heading-row">
      <div class="section-heading-main">
        <slot name="leading" />
        <div class="section-heading-copy">
          <slot name="heading"><component :is="`h${level}`" class="section-heading-title">{{ title }}</component></slot>
          <p v-if="description || $slots.description" class="section-heading-description"><slot name="description">{{ description }}</slot></p>
        </div>
      </div>
      <div v-if="$slots.actions" class="section-heading-actions"><slot name="actions" /></div>
    </div>
    <slot />
  </component>
</template>

<style scoped>
.section-heading-row, .section-heading-main, .section-heading-actions { display: flex; align-items: center; gap: 16px; min-width: 0; }
.section-heading-row { width: 100%; justify-content: space-between; flex-wrap: wrap; }
.section-heading-main { flex: 1; }
.section-heading-copy { min-width: 0; }
.section-heading-actions { flex-wrap: wrap; }
.section-heading-title { margin: 0; font-size: var(--section-heading-size, var(--text-heading, 20px)); font-weight: 600; letter-spacing: -.01em; line-height: 1.25; text-wrap: balance; }
.section-heading--page { --section-heading-size: var(--text-title, 28px); }
.section-heading--compact { --section-heading-size: var(--text-label, 14px); }
.section-heading-description { margin: 7px 0 0; color: var(--muted); font-size: var(--section-heading-description-size, var(--text-caption, 13px)); line-height: 1.45; text-wrap: pretty; }
</style>
