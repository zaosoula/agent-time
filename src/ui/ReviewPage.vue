<script setup lang="ts">
// Everything about reviewing a day in one place: the queue, marking the day reviewed, earlier days
// that still need a look, and gaps and notes.
import { computed, reactive, ref } from 'vue';
import { CheckCircle2, ChevronLeft, ChevronRight } from '@lucide/vue';
import HumanReview from './HumanReview.vue';
import SectionHeading from './SectionHeading.vue';
import AppCard from './AppCard.vue';
import DayNotes from './DayNotes.vue';
import DayPicker from './DayPicker.vue';
import { useStore } from './store.ts';
import { dateTime, duration, longDate, shortDate } from './format.ts';
import { toast } from './toast.ts';

const store = reactive(useStore());
const notes = ref<InstanceType<typeof DayNotes> | null>(null);
const marking = ref(false);

const pending = computed(() => store.reviewContextPending.length);
const captured = computed(() => store.reviewContextCaptured.length);
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
  <section class="day-content app-page review-page">
    <SectionHeading class="day-heading" title="Review" :description="`${longDate(store.selectedDate)} · Give each activity the right project.`" :level="1" size="page">
      <template #actions><DayPicker /></template>
    </SectionHeading>

    <AppCard padding="compact" class="review-summary">
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
                  ? `${pending} ${pending === 1 ? 'group needs' : 'groups need'} a project`
                  : 'No activity needs a project'
              }}
            </strong>
            <span>
              {{ captured }} automatically assigned · {{ store.dayGaps.length }}
              {{ store.dayGaps.length === 1 ? 'gap' : 'gaps' }} without activity
            </span>
          </div>
        </template>
      </div>
      <button
        v-if="canMark"
        class="btn btn-primary"
        :disabled="marking || Boolean(pending)"
        :title="pending ? 'Give the remaining groups a project first' : 'Mark the day reviewed; automatic assignments are already included'"
        @click="markReviewed"
      >
        Mark day reviewed
      </button>
    </AppCard>

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
