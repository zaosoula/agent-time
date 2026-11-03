<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { workOutcomeTransport } from './transport.ts';
import type { WorkOutcomes } from '../capture/work-outcomes.ts';
import DayPicker from './DayPicker.vue';
import { useStore } from './store.ts';
import { clock, duration, longDate } from './format.ts';
import { humanizeError } from './errors.ts';
import { projectDisplay } from './project-identity.ts';

const store = reactive(useStore());
const props = reactive({
  date: computed(() => store.selectedDate),
  project: computed(() => store.project),
  groups: computed(() => store.timelineProjects),
});
const loading = ref(false),
  error = ref(''),
  outcomes = ref<WorkOutcomes | null>(null);
let generation = 0;
const visible = computed(
  () =>
    outcomes.value?.projects.filter(
      (item) => props.project === 'all' || item.projectPath === props.project,
    ) || [],
);
const count = computed(() => visible.value.reduce((total, item) => total + item.commits.length, 0));
const groupByPath = computed(() => new Map(props.groups.map((group) => [group.name, group])));
const label = (path: string) => path.split('/').filter(Boolean).at(-1) || path;
const time = clock;

async function load() {
  const current = ++generation,
    date = props.date;
  loading.value = true;
  error.value = '';
  outcomes.value = null;
  try {
    const result = await workOutcomeTransport.list(date);
    if (current === generation && date === props.date) outcomes.value = result;
  } catch (cause) {
    if (current === generation) error.value = humanizeError(cause);
  } finally {
    if (current === generation) loading.value = false;
  }
}
watch(() => props.date, () => void load(), { immediate: true });
</script>

<template>
  <section class="day-content outcomes-page">
    <div class="day-heading">
      <div>
        <h1>Work evidence</h1>
        <p>
          {{ longDate(store.selectedDate) }} · Git commits near this day{{
            store.project === 'all' ? '' : ` in ${projectDisplay(store.project, store.projects)}`
          }}
        </p>
      </div>
      <DayPicker />
    </div>
  <div class="work-outcomes card">
    <div class="body">
      <div class="intro">
        <p>
          Commits provide context for a project. Their timestamps do not prove who or which agent made the
          change, and they do not alter tracked time.
        </p>
        <button class="btn btn-sm" :disabled="loading" @click="load">Refresh</button>
      </div>
      <p v-if="loading" role="status">Checking local Git history…</p>
      <p v-else-if="error" class="error" role="alert">{{ error }}</p>
      <template v-else-if="outcomes">
        <p v-if="!outcomes.gitAvailable">Git is unavailable on this Mac. Tracked time is unaffected.</p>
        <p v-else-if="!visible.length">
          No commits found on local branches or observed worktree HEADs for this day{{
            store.project === 'all' ? '' : ' and project'
          }}.
        </p>
        <div v-for="item in visible" :key="item.projectPath" class="project">
          <div class="project-heading">
            <strong :title="item.projectPath">{{ label(item.projectPath) }}</strong
            ><span v-if="groupByPath.get(item.projectPath)"
              >You {{ duration(groupByPath.get(item.projectPath)!.humanSeconds) }} · Agent
              {{ duration(groupByPath.get(item.projectPath)!.agentSeconds) }}</span
            ><span>{{ item.commits.length }}{{ item.moreCommits ? '+' : '' }} commits</span>
          </div>
          <small v-if="item.branches.length"
            >Current local {{ item.branches.length === 1 ? 'branch' : 'branches' }} checked:
            {{ item.branches.join(', ') }}</small
          >
          <ol>
            <li v-for="commit in item.commits" :key="commit.hash">
              <time :datetime="new Date(commit.committedAt * 1000).toISOString()">{{
                time(commit.committedAt)
              }}</time
              ><code :title="commit.hash">{{ commit.hash.slice(0, 8) }}</code
              ><span>{{ commit.subject || 'Untitled commit' }}</span>
            </li>
          </ol>
          <small v-if="item.moreCommits">Showing the 12 most recent commits for this project.</small>
        </div>
        <p
          v-if="outcomes.skippedProjects || outcomes.skippedWorktrees || outcomes.unavailableProjects"
          class="limit"
        >
          History is partial: {{ outcomes.skippedProjects }} additional projects and
          {{ outcomes.skippedWorktrees }} observed worktrees were not checked;
          {{ outcomes.unavailableProjects }} project repositories could not be read.
        </p>
      </template>
    </div>
  </div>
  </section>
</template>

<style scoped>
.work-outcomes {
  margin: 16px 0;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
  overflow: hidden;
}
.heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  padding: 15px 17px;
  text-align: left;
}
.heading span:first-child {
  display: flex;
  align-items: center;
  gap: 10px;
}
.heading strong {
  font-size: 12px;
}
.heading small,
.heading span:last-child {
  font-size: var(--text-xs);
  color: var(--muted);
}
.body {
  border-top: 1px solid var(--border);
  padding: 15px 17px;
}
.body p,
.body small {
  font-size: 11px;
  line-height: 1.5;
  color: var(--muted);
}
.intro {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
}
.intro button {
  flex: none;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--hover);
  padding: 7px 9px;
  font-size: 11px;
}
.intro button:disabled {
  opacity: 0.5;
}
.body .error {
  color: #bd5050;
}
.project {
  border-top: 1px solid var(--border);
  padding: 10px 0;
}
.project-heading {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  align-items: baseline;
  font-size: 11px;
}
.project-heading strong {
  font-size: 12px;
}
.project-heading span {
  color: var(--muted);
}
.project ol {
  list-style: none;
  margin: 8px 0;
  padding: 0;
}
.project li {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 5px 0;
  font-size: 11px;
  overflow-wrap: anywhere;
}
.project time,
.project code {
  flex: none;
  color: var(--muted);
  font-size: var(--text-xs);
}
.project code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.limit {
  color: #a06b28 !important;
}
</style>
