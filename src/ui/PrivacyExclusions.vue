<script setup lang="ts">
import AppCard from './AppCard.vue';
import SectionHeading from './SectionHeading.vue';
import { computed, onMounted, ref } from 'vue';
import { privacyTransport } from './transport.ts';
import type { PrivacyExclusion } from '../capture/privacy-exclusions.ts';
import { humanizeError } from './errors.ts';
import { clearToast, toast } from './toast.ts';

const entries = ref<PrivacyExclusion[]>([]),
  kind = ref<'app' | 'site'>('app'),
  value = ref(''),
  busy = ref(false),
  loadError = ref(''),
  hint = ref('');
const trimmed = computed(() => value.value.trim());
const duplicate = computed(() =>
  entries.value.some(
    (item) =>
      item.kind === kind.value && item.value.toLocaleLowerCase() === trimmed.value.toLocaleLowerCase(),
  ),
);
onMounted(async () => {
  try {
    entries.value = await privacyTransport.list();
  } catch (cause) {
    loadError.value = humanizeError(cause);
  }
});
async function save(next: PrivacyExclusion[], success: string): Promise<boolean> {
  busy.value = true;
  try {
    entries.value = await privacyTransport.replace(next);
    clearToast('privacy');
    toast.success(success);
    return true;
  } catch (cause) {
    toast.error(cause, 'privacy');
    return false;
  } finally {
    busy.value = false;
  }
}
async function add() {
  hint.value = '';
  if (busy.value || !trimmed.value) return;
  if (duplicate.value) {
    hint.value = `${trimmed.value} is already excluded.`;
    return;
  }
  const item = { kind: kind.value, value: trimmed.value };
  if (await save([...entries.value, item], `${item.value} excluded. Existing history is unchanged.`))
    value.value = '';
}
async function remove(item: PrivacyExclusion) {
  await save(
    entries.value.filter((other) => other !== item),
    `${item.value} is no longer excluded.`,
  );
}
</script>
<template>
  <AppCard as="section" padding="regular" class="privacy-exclusions">
    <SectionHeading title="Activity exclusions" :level="3" size="compact"><template #description>
      Agent Time does not store foreground samples while an excluded app or exact website hostname is active.
      When site exclusions are set and the current browser hostname is unavailable, Agent Time discards that
      browser sample too. Existing history is kept. Agent hooks remain independent.
    </template></SectionHeading>
    <form class="privacy-entry" @submit.prevent="add">
      <select v-model="kind" aria-label="Exclusion type" @change="hint = ''">
        <option value="app">App bundle ID</option>
        <option value="site">Website hostname</option>
      </select>
      <input
        v-model="value"
        :placeholder="kind === 'app' ? 'com.example.app' : 'example.com'"
        aria-label="App bundle ID or website hostname"
        :aria-invalid="duplicate || undefined"
        aria-describedby="privacy-hint"
        @input="hint = ''"
      />
      <button type="submit" class="btn" :disabled="busy || !trimmed || duplicate">Add exclusion</button>
    </form>
    <p v-if="hint || duplicate" id="privacy-hint" class="privacy-hint" role="status">
      {{ hint || `${trimmed} is already excluded.` }}
    </p>
    <ul>
      <li v-for="item in entries" :key="item.kind + item.value">
        <span>{{ item.kind === 'app' ? 'App' : 'Website' }} · {{ item.value }}</span>
        <button
          class="btn btn-sm"
          :disabled="busy"
          :aria-label="`Remove ${item.value}`"
          @click="remove(item)"
        >
          Remove
        </button>
      </li>
    </ul>
    <p v-if="!entries.length && !loadError" class="privacy-empty">No exclusions yet.</p>
    <p v-if="loadError" class="privacy-error" role="alert">{{ loadError }}</p>
  </AppCard>
</template>
<style scoped>
.privacy-exclusions {
  margin-top: 16px;
}
.privacy-exclusions h3 {
  font-size: var(--text-md);
  margin: 0 0 6px;
}
.privacy-exclusions p {
  font-size: var(--text-xs);
  color: var(--muted);
  line-height: 1.5;
}
.privacy-entry {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 15px;
}
.privacy-entry input {
  flex: 1;
  min-width: 180px;
}
.privacy-entry select,
.privacy-entry input {
  border: 1px solid var(--border);
  border-radius: var(--control-radius);
  background: var(--hover);
  color: var(--text);
  min-height: var(--control-height);
  box-sizing: border-box;
  padding: var(--control-padding-block) var(--control-padding-inline);
  font-size: var(--control-font-size);
  line-height: var(--control-line-height);
}
.privacy-exclusions ul {
  list-style: none;
  margin: 14px 0 0;
  padding: 0;
}
.privacy-exclusions li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  padding: 7px 0;
  border-top: 1px solid var(--border);
  font-size: var(--text-sm);
}
.privacy-exclusions li span {
  overflow-wrap: anywhere;
}
.privacy-hint {
  color: var(--status-warning) !important;
}
.privacy-error {
  color: var(--status-danger) !important;
}
</style>
