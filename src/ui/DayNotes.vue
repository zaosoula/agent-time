<script setup lang="ts">
// Gaps without observations and the notes you add about them, in one place. A note can be started
// from a gap, from a review row, or from scratch with any time range on the selected day.
import { computed, nextTick, reactive, ref, watch } from 'vue';
import {
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from 'reka-ui';
import { Plus, StickyNote } from '@lucide/vue';
import { manualNoteTransport } from './transport.ts';
import { useStore } from './store.ts';
import { clock, duration } from './format.ts';
import { humanizeError } from './errors.ts';
import { toast } from './toast.ts';

const store = reactive(useStore());

const dialogOpen = ref(false),
  label = ref(''),
  from = ref(''),
  to = ref(''),
  project = ref(''),
  text = ref(''),
  error = ref(''),
  saving = ref(false),
  removing = ref('');
const textField = ref<HTMLTextAreaElement | null>(null);

const daySpan = computed(() => store.dayEnd - store.dayStart);
const gapSources = computed(
  () =>
    [
      ...new Set(
        store.dayIntervals
          .filter((interval) => interval.state === 'human' || interval.state === 'grouped')
          .map((interval) =>
            interval.state === 'human'
              ? 'Mac activity'
              : store.status?.sources.find((source) => source.id === interval.provider)?.name ||
                interval.provider ||
                'agent activity',
          ),
      ),
    ].join(', ') || 'activity',
);
const sortedNotes = computed(() => [...store.notes].sort((a, b) => a.start - b.start));
const notedGap = (gap: { start: number; end: number }) =>
  store.notes.some((note) => note.start === gap.start && note.end === gap.end);

const timeInput = (seconds: number) => new Date(seconds * 1000).toTimeString().slice(0, 5);

/** Open the note dialog for a time range. Called by gaps, review rows and the add button. */
function open(start?: number, end?: number, context = '') {
  const base = start ?? Math.min(store.dayEnd - 3600, Math.max(store.dayStart, store.minute - 3600));
  from.value = timeInput(base);
  to.value = timeInput(end ?? base + 3600);
  label.value = context;
  project.value = '';
  text.value = '';
  error.value = '';
  dialogOpen.value = true;
  void nextTick(() => textField.value?.focus());
}
defineExpose({ open });

watch(
  () => store.selectedDate,
  () => {
    dialogOpen.value = false;
  },
);

async function save() {
  const date = store.selectedDate;
  const start = new Date(`${date}T${from.value}:00`).getTime() / 1000,
    end = new Date(`${date}T${to.value}:00`).getTime() / 1000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    error.value = 'Choose a start and an end on this day, with the end after the start.';
    return;
  }
  if (!text.value.trim()) return;
  saving.value = true;
  error.value = '';
  try {
    await manualNoteTransport.add({ start, end, project: project.value.trim(), note: text.value.trim() });
    dialogOpen.value = false;
    toast.success('Note saved. Notes never change your recorded time.', 'note');
    await store.refreshNotes();
  } catch (cause) {
    error.value = humanizeError(cause);
  } finally {
    saving.value = false;
  }
}

async function remove(id: string) {
  removing.value = id;
  try {
    await manualNoteTransport.remove(id);
    toast.success('Note removed.', 'note-remove');
    await store.refreshNotes();
  } catch (cause) {
    toast.error(cause, 'note-remove');
  } finally {
    removing.value = '';
  }
}
</script>

<template>
  <section class="day-notes card" aria-labelledby="day-notes-title">
    <header>
      <div>
        <h2 id="day-notes-title">Gaps and notes</h2>
        <p>
          A gap means nothing was observed for at least five minutes; it does not prove you were idle. Notes are
          for your own context and never add to recorded time.
        </p>
      </div>
      <button class="btn" @click="open()"><Plus :size="13" />Add note</button>
    </header>

    <div v-if="store.dayGaps.length" class="gap-track" aria-label="Gaps on this day">
      <button
        v-for="gap in store.dayGaps"
        :key="gap.start"
        :class="{ noted: notedGap(gap) }"
        :style="{
          left: `${((gap.start - store.dayStart) / daySpan) * 100}%`,
          width: `${((gap.end - gap.start) / daySpan) * 100}%`,
        }"
        :title="`${clock(gap.start)}–${clock(gap.end)} · ${duration(gap.seconds)} without ${gapSources}`"
        :aria-label="`${duration(gap.seconds)} without ${gapSources} from ${clock(gap.start)} to ${clock(gap.end)}; add a note`"
        @click="open(gap.start, gap.end, 'gap')"
      ></button>
    </div>

    <ul v-if="store.dayGaps.length" class="gap-list">
      <li v-for="gap in store.dayGaps.slice(0, 30)" :key="gap.start">
        <span>{{ clock(gap.start) }}–{{ clock(gap.end) }}</span>
        <span class="gap-length">{{ duration(gap.seconds) }} without activity</span>
        <button v-if="!notedGap(gap)" class="btn btn-quiet btn-sm" @click="open(gap.start, gap.end, 'gap')">
          Add note
        </button>
        <span v-else class="badge good">Noted</span>
      </li>
    </ul>
    <p v-else class="day-notes-empty">
      No gaps of five minutes or more between observations on this day.
    </p>

    <h3 v-if="sortedNotes.length">Notes</h3>
    <ul v-if="sortedNotes.length" class="note-list">
      <li v-for="item in sortedNotes" :key="item.id">
        <StickyNote :size="14" />
        <div>
          <strong>{{ clock(item.start) }}–{{ clock(item.end) }} · {{ item.project || 'No project' }}</strong>
          <span>{{ item.note }}</span>
        </div>
        <button class="btn btn-quiet btn-sm" :disabled="removing === item.id" @click="remove(item.id)">
          Remove
        </button>
      </li>
    </ul>
  </section>

  <DialogRoot v-model:open="dialogOpen">
    <DialogPortal>
      <DialogOverlay class="export-backdrop" />
      <DialogContent as-child>
        <form class="export-review note-dialog" @submit.prevent="save">
          <DialogTitle>{{ label ? `Note this ${label}` : 'Add a note' }}</DialogTitle>
          <DialogDescription>Notes are for your own context and never add to recorded time.</DialogDescription>
          <div class="note-times">
            <label>From <input v-model="from" type="time" required /></label>
            <label>To <input v-model="to" type="time" required /></label>
          </div>
          <label>Project (optional)<input v-model="project" placeholder="Project name" /></label>
          <label>
            What happened?
            <textarea
              ref="textField"
              v-model="text"
              maxlength="500"
              required
              placeholder="Add context for this time"
            />
          </label>
          <p v-if="error" class="note-error" role="alert">{{ error }}</p>
          <div>
            <button type="button" class="btn" @click="dialogOpen = false">Cancel</button>
            <button type="submit" class="btn btn-primary" :disabled="saving || !text.trim()">Save note</button>
          </div>
        </form>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style>
.day-notes {
  margin: var(--space-4) 0;
  padding: var(--space-4) var(--space-5);
}
.day-notes header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
}
.day-notes h2 {
  margin: 0 0 4px;
  font-size: var(--text-md);
}
.day-notes h3 {
  margin: var(--space-4) 0 var(--space-2);
  font-size: var(--text-sm);
}
.day-notes p {
  margin: 0;
  color: var(--muted);
  font-size: var(--text-sm);
  line-height: 1.5;
}
.day-notes .gap-track {
  position: relative;
  height: 14px;
  margin: var(--space-4) 0 var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--hover);
}
.day-notes .gap-track button {
  position: absolute;
  top: 0;
  bottom: 0;
  min-width: 3px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--status-warning) 55%, transparent);
}
.day-notes .gap-track button.noted {
  background: color-mix(in srgb, var(--status-good) 55%, transparent);
}
.day-notes .gap-track button:hover {
  background: var(--status-warning);
}
.gap-list,
.note-list {
  display: grid;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: var(--text-sm);
}
.gap-list li {
  display: grid;
  grid-template-columns: 130px minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--space-3);
  min-height: 30px;
  font-variant-numeric: tabular-nums;
}
.gap-length {
  color: var(--muted);
}
.day-notes-empty {
  margin-top: var(--space-3) !important;
}
.note-list li {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-2) 0;
  border-top: 1px solid var(--border);
}
.note-list li > svg {
  flex: none;
  margin-top: 2px;
  color: var(--muted);
}
.note-list li > div {
  flex: 1;
  display: grid;
  gap: 2px;
}
.note-times {
  display: flex;
  gap: var(--space-3);
}
.note-times label {
  flex: 1;
}
.note-error {
  color: var(--status-danger) !important;
}
</style>
