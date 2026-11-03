<script setup lang="ts">
// Everything about reviewing a day in one place: the queue, marking the day reviewed, earlier days
// that still need a look, and gaps and notes.
import { computed, reactive, ref } from 'vue';
import { CheckCircle2, ChevronLeft, ChevronRight } from '@lucide/vue';
import HumanReview from './HumanReview.vue';
import DayNotes from './DayNotes.vue';
import DayPicker from './DayPicker.vue';
import { useStore } from './store.ts';
import { dateTime, duration, longDate, shortDate } from './format.ts';
import { toast } from './toast.ts';

const store = reactive(useStore());
const notes = ref<InstanceType<typeof DayNotes> | null>(null);
const marking = ref(false);

const pending = computed(() => store.reviewPending.length);
const captured = computed(() => store.reviewCaptured.length);
const canMark = computed(
  () => Boolean(store.dayReview?.hasActivity) && (!store.dayReview?.completedAt || store.dayReview.stale),
);

/** Days with something to review, oldest first, including the selected day when it needs work. */
const backlog = computed(() => [...(store.dayReview?.backlog || [])].sort((a, b) => a.date.localeCompare(b.date)));
const previousBacklog = computed(() =>
  [...backlog.value].reverse().find((item) => item.date < store.selectedDate),
);
const nextBacklog = computed(() => backlog.value.find((item) => item.date > store.selectedDate));

async function markReviewed() {
  marking.value = true;
  try {
    await store.markDayReviewed();
    toast.success(`${longDate(store.selectedDate)} marked as reviewed.`, 'day-review');
  } catch (cause) {
    toast.error(cause, 'day-review');
  } finally {
    marking.value = false;
  }
}
</script>

<template>
  <section class="day-content review-page">
    <div class="day-heading">
      <div>
        <h1>Review</h1>
        <p>{{ longDate(store.selectedDate) }}: give each piece of activity the right project.</p>
      </div>
      <DayPicker />
    </div>

    <div class="review-summary card">
      <div class="review-summary-status">
        <template v-if="store.dayReviewed">
          <CheckCircle2 :size="18" class="good" />
          <div>
            <strong>Day reviewed</strong>
            <span v-if="store.dayReview?.completedAt">
              Marked {{ dateTime(store.dayReview.completedAt) }}. New activity or changes reopen the day.
            </span>
          </div>
        </template>
        <template v-else-if="!store.summaryLoaded">
          <span class="skeleton" style="width: 220px; height: 16px"></span>
        </template>
        <template v-else>
          <div>
            <strong>
              {{
                pending
                  ? `${pending} ${pending === 1 ? 'item needs' : 'items need'} a project`
                  : store.dayReview?.stale
                    ? 'Something changed since your last review'
                    : captured
                      ? 'Everything left was matched automatically'
                      : 'Nothing to review'
              }}
            </strong>
            <span>
              {{ captured }} matched automatically · {{ store.dayGaps.length }}
              {{ store.dayGaps.length === 1 ? 'gap' : 'gaps' }} without activity
            </span>
          </div>
        </template>
      </div>
      <button
        v-if="canMark"
        class="btn btn-primary"
        :disabled="marking || Boolean(pending)"
        :title="pending ? 'Give the remaining items a project first' : 'Accept the automatic matches and mark the day reviewed'"
        @click="markReviewed"
      >
        {{ captured ? 'Accept matches and mark reviewed' : 'Mark day reviewed' }}
      </button>
    </div>

    <nav v-if="backlog.length" class="review-days" aria-label="Other days to review">
      <button class="btn btn-sm" :disabled="!previousBacklog" @click="previousBacklog && store.setDate(previousBacklog.date)">
        <ChevronLeft :size="13" />Earlier
      </button>
      <div class="review-days-list">
        <button
          v-for="item in backlog"
          :key="item.date"
          class="badge"
          :class="{ info: item.date === store.selectedDate }"
          :aria-current="item.date === store.selectedDate ? 'date' : undefined"
          :title="`${item.pendingGroups} items · ${duration(item.unmatchedSeconds)} without a project · ${item.gaps} gaps`"
          @click="store.setDate(item.date)"
        >
          {{ shortDate(item.date) }} · {{ item.pendingGroups }}
        </button>
      </div>
      <button class="btn btn-sm" :disabled="!nextBacklog" @click="nextBacklog && store.setDate(nextBacklog.date)">
        Later<ChevronRight :size="13" />
      </button>
    </nav>

    <HumanReview @note="(start, end, label) => notes?.open(start, end, label)" />
    <DayNotes ref="notes" />
  </section>
</template>

<style>
.review-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-4);
  margin-bottom: var(--space-3);
}
.review-summary-status {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.review-summary-status div {
  display: grid;
  gap: 2px;
}
.review-summary-status span {
  color: var(--muted);
  font-size: var(--text-sm);
}
.review-summary-status .good {
  color: var(--status-good);
}
.review-days {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
  font-size: var(--text-sm);
}
.review-days-list {
  display: flex;
  gap: var(--space-1);
  flex: 1;
  overflow-x: auto;
}
.review-days-list .badge {
  cursor: pointer;
}
</style>
