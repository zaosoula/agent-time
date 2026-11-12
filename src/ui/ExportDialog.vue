<script setup lang="ts">
import { computed, reactive } from 'vue';
import {
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from 'reka-ui';
import { minuteCreditSeconds } from '../capture/correlate.ts';
import { humanReviewState } from '../capture/human-review.ts';
import { useStore } from './store.ts';
import { duration, longDate } from './format.ts';
import { intervalProject, projectDisplay, sessionProject, unassignedProject } from './project-identity.ts';

const open = defineModel<boolean>('open', { required: true });
const store = reactive(useStore());

const groups = computed(() => store.exportReviewGroups);
const decided = computed(() => groups.value.filter((group) => Boolean(group.userAttribution)).length);
const unmatched = computed(() => groups.value.filter((group) => humanReviewState(group) === 'unmatched'));
const conflicts = computed(() => groups.value.filter((group) => humanReviewState(group) === 'conflict'));
const captured = computed(() => groups.value.filter((group) => humanReviewState(group) === 'captured'));
const pending = computed(() => unmatched.value.length + conflicts.value.length);

function openReview() {
  open.value = false;
  store.navigate('review');
}

function exportCsv() {
  open.value = false;
  const headers = [
    'Project',
    'Activity',
    'Run',
    'Task',
    'Agent seconds',
    'Observed tool seconds',
    'State',
    'Proof',
    'Human seconds',
    'Source',
  ];
  const humanProjects = new Map<string, Array<[number, number]>>();
  for (const interval of store.filteredIntervals.filter((item) => item.state === 'human')) {
    const session = interval.sessionId
      ? store.summary.sessions.find((s) => s.sessionId === interval.sessionId && s.hostId === interval.hostId)
      : undefined;
    const name = (interval.workspaceId || interval.projectPath || interval.userAttribution)
      ? intervalProject(interval)
      : session
        ? sessionProject(session)
        : unassignedProject;
    const ranges = humanProjects.get(name) || [];
    ranges.push([interval.start, interval.end]);
    humanProjects.set(name, ranges);
  }
  const rows = [
    ...store.creditedSessions.map((session) => [
      sessionProject(session),
      session.title,
      session.runId || '',
      session.taskId || '',
      String(Math.round(session.seconds)),
      String(Math.round(session.observedSeconds)),
      session.state,
      session.proof,
      '0',
      'Agent session',
    ]),
    ...[...humanProjects].map(([name, ranges]) => [
      name,
      'Human activity',
      '',
      '',
      '0',
      '0',
      '',
      'estimated',
      String(minuteCreditSeconds(ranges)),
      'Foreground activity',
    ]),
  ];
  const csv = [headers, ...rows]
    .map((row) =>
      row.map((value) => '"' + (/^[=+\-@]/.test(value) ? "'" + value : value).replaceAll('"', '""') + '"').join(','),
    )
    .join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `agent-time-${store.project === 'all' ? 'all-projects' : store.project.replace(/[^a-zA-Z0-9_-]/g, '-')}-${store.selectedDate}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay class="export-backdrop" />
      <DialogContent class="export-review">
        <DialogTitle>Export this day</DialogTitle>
        <DialogDescription>
          {{ longDate(store.selectedDate) }} ·
          {{ store.project === 'all' ? 'All projects' : projectDisplay(store.project, store.projects) }}
        </DialogDescription>
        <p v-if="pending" class="export-warning">
          {{ pending }} {{ pending === 1 ? 'item still needs' : 'items still need' }} a project.
          <button class="btn btn-quiet btn-sm" @click="openReview">Review them first</button>
        </p>
        <dl>
          <dt>Decided by you</dt>
          <dd>{{ decided }}</dd>
          <dt>Waiting for a decision</dt>
          <dd>{{ pending }}</dd>
          <dt>Matched automatically</dt>
          <dd>{{ captured.length }} · {{ store.dayReviewed ? 'accepted' : 'not yet accepted' }}</dd>
          <dt>Without a project</dt>
          <dd>
            {{ duration(unmatched.reduce((total, group) => total + group.seconds, 0)) }} ·
            {{ unmatched.length }} items
          </dd>
          <dt>Conflicting matches</dt>
          <dd>{{ conflicts.length }}</dd>
          <dt>Gaps with no activity</dt>
          <dd>{{ store.dayGaps.length }}</dd>
        </dl>
        <p>
          The CSV includes recorded activity and your project decisions, even if the day is not fully reviewed.
          Session search does not change it. Gaps are never counted as work.
        </p>
        <div>
          <button class="btn" @click="open = false">Cancel</button>
          <button class="btn btn-primary" @click="exportCsv">Export CSV</button>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style>
.export-warning {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 8px 10px;
  border-radius: var(--radius-md);
  background: var(--status-warning-soft);
  color: var(--text) !important;
}
</style>
