<script setup lang="ts">
import { computed, onMounted, onUnmounted, onActivated, reactive, ref, watch } from 'vue';
import { ChevronLeft, ChevronRight } from '@lucide/vue';
import { weeklyTransport } from './transport.ts';
import { reviewedCsv, type WeeklyReview } from '../capture/weekly.ts';
import { useStore } from './store.ts';
import { dateString, duration, shiftDate, shortDate } from './format.ts';
import { humanizeError } from './errors.ts';
import { windowVisible } from './polling.ts';

const store = reactive(useStore());
const review = ref<WeeklyReview | null>(null),
  error = ref(''),
  loading = ref(false);
const goals = ref<Record<string, number>>({}),
  remind = ref(false);
const goalKey = 'agent-time:weekly-reviewed-goals:v1',
  remindKey = 'agent-time:weekly-goal-reminders:v1';
let refreshTimer: ReturnType<typeof setInterval> | undefined;
const refreshedAt = ref<number | null>(null);
onMounted(() => {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(goalKey) || '{}');
    if (saved && typeof saved === 'object' && !Array.isArray(saved))
      goals.value = Object.fromEntries(
        Object.entries(saved).filter(
          (entry): entry is [string, number] =>
            entry[0].startsWith('/') &&
            typeof entry[1] === 'number' &&
            Number.isFinite(entry[1]) &&
            entry[1] >= 0 &&
            entry[1] <= 168,
        ),
      );
    remind.value = localStorage.getItem(remindKey) === 'true';
  } catch {
    /* Keep goals optional when local storage is unavailable. */
  }
  refreshTimer = setInterval(() => {
    if (windowVisible.value && store.page === 'weekly' && !loading.value) void load();
  }, 60_000);
});
onUnmounted(() => clearInterval(refreshTimer));
function setGoal(path: string, event: Event) {
  const hours = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(hours) || hours < 0 || hours > 168) return;
  goals.value = { ...goals.value, [path]: hours };
  try {
    localStorage.setItem(goalKey, JSON.stringify(goals.value));
  } catch {
    /* In-memory goal still works for this session. */
  }
}
function setReminder(event: Event) {
  remind.value = (event.target as HTMLInputElement).checked;
  try {
    localStorage.setItem(remindKey, String(remind.value));
  } catch {
    /* In-memory reminder still works for this session. */
  }
}
let loadGeneration = 0;
let requestedContext = '', committedContext = '';
function currentContext() { return `${monday.value}:${store.reviewRevision}`; }
function refreshContext() {
  const context = currentContext();
  if (store.page !== 'weekly' || loading.value && requestedContext === context || review.value && committedContext === context || error.value && requestedContext === context) return;
  void load();
}
onActivated(refreshContext);
const monday = computed(() => {
  const day = new Date(store.selectedDate + 'T12:00:00');
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
});
const label = (path: string) =>
  path === 'Unassigned' ? path : path.split('/').filter(Boolean).at(-1) || path;
const trendMax = computed(() =>
  Math.max(
    60,
    ...(review.value?.days.flatMap((day) => [day.humanSeconds, day.agentSeconds, day.elapsedSeconds]) || []),
  ),
);
const width = (seconds: number) => `${Math.max(0, (seconds / trendMax.value) * 100)}%`;
async function load() {
  const generation = ++loadGeneration,
    startDate = monday.value,
    revision = store.reviewRevision;
  requestedContext = currentContext();
  loading.value = true;
  error.value = '';
  try {
    const next = await weeklyTransport.review(startDate);
    if (generation === loadGeneration && startDate === monday.value && revision === store.reviewRevision) {
      review.value = next;
      committedContext = `${startDate}:${revision}`;
      refreshedAt.value = Date.now();
    }
  } catch (cause) {
    if (generation === loadGeneration) error.value = humanizeError(cause);
  } finally {
    if (generation === loadGeneration) loading.value = false;
  }
}
watch([monday, () => store.reviewRevision], refreshContext, { immediate: true });
const weekEnd = computed(() => shiftDate(monday.value, 6));
const thisWeek = computed(() => monday.value <= dateString(new Date()) && dateString(new Date()) <= weekEnd.value);
function exportReviewed() {
  if (!review.value?.reviewedEntries.length) return;
  const blob = new Blob([reviewedCsv(review.value.reviewedEntries)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob),
    link = document.createElement('a');
  link.href = url;
  link.download = `agent-time-reviewed-${monday.value}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
</script>
<template>
  <section class="day-content weekly-page">
    <div class="day-heading">
      <div>
        <h1>Weekly review</h1>
        <p>{{ shortDate(monday) }} – {{ shortDate(weekEnd) }}</p>
      </div>
      <div class="date-controls">
        <button class="icon-button" aria-label="Previous week" @click="store.setDate(shiftDate(store.selectedDate, -7))">
          <ChevronLeft :size="16" />
        </button>
        <button class="icon-button" aria-label="Next week" @click="store.setDate(shiftDate(store.selectedDate, 7))">
          <ChevronRight :size="16" />
        </button>
        <button class="btn btn-sm" :disabled="thisWeek" @click="store.setDate(dateString(new Date()))">This week</button>
      </div>
    </div>
    <div class="weekly-review card">
    <div class="weekly-body">
      <p>
        Your time, agent time and elapsed time are measured separately. When agents work in parallel, agent
        time can be more than the time that passed.
      </p>
      <p v-if="loading && !review" role="status">Loading week…</p>
      <p v-if="error" class="weekly-error" role="alert">{{ error }}</p>
      <template v-if="review"
        ><div class="weekly-totals">
          <span
            >You <strong>{{ duration(review.totals.humanSeconds) }}</strong></span
          ><span
            >Agent <strong>{{ duration(review.totals.agentSeconds) }}</strong> <small>({{ duration(review.totals.agentWallSeconds) }} wall clock)</small></span
          ><span
            >Elapsed <strong>{{ duration(review.totals.elapsedSeconds) }}</strong></span
          >
        </div>
        <p v-if="refreshedAt">Refreshes every minute.</p>
        <div class="weekly-trend" aria-label="Daily activity trend">
          <div v-for="day in review.days" :key="day.date" class="trend-day">
            <strong class="trend-date">{{ shortDate(day.date) }}</strong>
            <div class="trend-bars">
              <span
                class="mac"
                :style="{ width: width(day.humanSeconds) }"
                :title="`You ${duration(day.humanSeconds)}`"
              ></span
              ><span
                class="agent"
                :style="{ width: width(day.agentSeconds) }"
                :title="`Agent ${duration(day.agentSeconds)} cumulative · ${duration(day.agentWallSeconds)} wall clock`"
              ></span
              ><span
                class="elapsed"
                :style="{ width: width(day.elapsedSeconds) }"
                :title="`Elapsed ${duration(day.elapsedSeconds)}`"
              ></span>
            </div>
            <small
              >You {{ duration(day.humanSeconds) }} · Agent {{ duration(day.agentSeconds) }} · Elapsed
              {{ duration(day.elapsedSeconds) }}</small
            >
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Project</th>
              <th>You</th>
              <th title="Every session and subagent counted in full">Agent</th>
              <th title="Clock time with any agent working">Agent wall</th>
              <th>Elapsed</th>
              <th>Reviewed</th>
              <th>Reviewed goal</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="project in review.projects" :key="project.project">
              <td :title="project.project">{{ label(project.project) }}</td>
              <td>{{ duration(project.humanSeconds) }}</td>
              <td>{{ duration(project.agentSeconds) }}</td>
              <td>{{ duration(project.agentWallSeconds) }}</td>
              <td>{{ duration(project.elapsedSeconds) }}</td>
              <td>{{ duration(project.reviewedSeconds) }}</td>
              <td>
                <input
                  class="goal-input"
                  type="number"
                  min="0"
                  max="168"
                  step="0.5"
                  :value="goals[project.project] || 0"
                  :aria-label="`Weekly reviewed hours goal for ${label(project.project)}`"
                  @change="setGoal(project.project, $event)"
                />
                h
                <small v-if="goals[project.project]"
                  >{{
                    Math.min(
                      100,
                      Math.round((project.reviewedSeconds / (goals[project.project] * 3600)) * 100),
                    )
                  }}%</small
                >
              </td>
            </tr>
            <tr v-if="!review.projects.length">
              <td colspan="7">No recorded activity this week.</td>
            </tr>
          </tbody>
        </table>
        <label class="goal-reminder"
          ><input type="checkbox" :checked="remind" @change="setReminder" /> Remind me here when reviewed
          project time is below its weekly goal</label
        >
        <p
          v-if="
            remind &&
            review.projects.some(
              (project) =>
                goals[project.project] > 0 && project.reviewedSeconds < goals[project.project] * 3600,
            )
          "
          role="status"
        >
          Reviewed time is below a weekly goal. Decide unresolved activity and mark the day reviewed to accept
          captured project matches.
        </p>
        <button class="weekly-export" :disabled="!review.reviewedEntries.length" @click="exportReviewed">
          Export {{ review.reviewedEntries.length }} reviewed entries</button
        ><small
          >The CSV contains Mac intervals with explicit decisions or captured project matches accepted by day
          review. Raw observations are unchanged.</small
        >
      </template>
    </div>
    </div>
  </section>
</template>
<style scoped>
.weekly-review {
  margin: 16px 0;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
  overflow: hidden;
}
.weekly-heading {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 15px 17px;
  text-align: left;
}
.weekly-heading span:first-child {
  display: flex;
  align-items: center;
  gap: 10px;
}
.weekly-heading strong {
  font-size: 12px;
}
.weekly-heading small,
.weekly-heading span:last-child {
  font-size: var(--text-xs);
  color: var(--muted);
}
.weekly-body {
  border-top: 1px solid var(--border);
  padding: 15px 17px;
}
.weekly-body p,
.weekly-body small {
  font-size: 11px;
  line-height: 1.5;
  color: var(--muted);
}
.weekly-error {
  color: var(--status-danger) !important;
}
.weekly-totals {
  display: flex;
  gap: 22px;
  flex-wrap: wrap;
  padding: 12px 0;
  font-size: 11px;
}
.weekly-totals span {
  display: flex;
  gap: 7px;
}
.weekly-review table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
  text-align: left;
}
.weekly-review th,
.weekly-review td {
  padding: 8px;
  border-bottom: 1px solid var(--border);
}
.weekly-review td:first-child {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.weekly-export {
  padding: 7px 9px;
  margin: 14px 8px 0 0;
  background: var(--hover);
  border-radius: 6px;
  font-size: 11px;
}
.weekly-export:disabled {
  opacity: 0.5;
}
.weekly-trend {
  display: grid;
  gap: 6px;
  margin: 10px 0 16px;
}
.trend-day {
  display: grid;
  grid-template-columns: 84px minmax(100px, 1fr) auto;
  gap: 8px;
  align-items: center;
  font-size: var(--text-xs);
}
.trend-day strong {
  font-size: var(--text-xs);
}
.trend-day small {
  white-space: nowrap;
}
.trend-bars {
  display: grid;
  gap: 2px;
}
.trend-bars span {
  display: block;
  height: 3px;
  min-width: 0;
  border-radius: 2px;
}
.trend-bars .mac {
  background: var(--status-warning);
}
.trend-bars .agent {
  background: #7769d9;
}
.trend-bars .elapsed {
  background: var(--status-good);
}
@media (max-width: 700px) {
  .trend-day {
    grid-template-columns: 84px 1fr;
  }
  .trend-day small {
    grid-column: 2;
  }
}
.goal-input {
  width: 48px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--hover);
  color: var(--text);
  padding: 3px;
  font-size: var(--text-xs);
}
.goal-reminder {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 13px 0 0;
  font-size: var(--text-xs);
  color: var(--muted);
}
</style>
