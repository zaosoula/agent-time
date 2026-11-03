<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import { useStore } from './store.ts';
import { duration } from './format.ts';
import { projectDisplay, sessionProject } from './project-identity.ts';

const store = reactive(useStore());
const tableLimit = ref(100);
watch(
  () => store.selectedDate,
  () => (tableLimit.value = 100),
);
</script>

<template>
  <div class="sessions-table">
    <table>
      <thead>
        <tr>
          <th>Session</th>
          <th>Project / run</th>
          <th>Status</th>
          <th>Agent time</th>
          <th>Tool time</th>
          <th>Evidence</th>
        </tr>
      </thead>
      <tbody>
        <template v-if="!store.summaryLoaded">
          <tr v-for="index in 4" :key="index" aria-hidden="true">
            <td colspan="6"><span class="skeleton" style="height: 14px; width: 70%"></span></td>
          </tr>
        </template>
        <tr
          v-for="session in store.visibleSessions.slice(0, tableLimit)"
          v-else
          :key="session.key"
          :class="{ focused: store.selectedSessionKey === session.key }"
          @click="store.selectedSessionKey = session.key"
        >
          <td>
            <button class="session-open" @click.stop="store.selectedSessionKey = session.key">
              <strong>{{ session.title }}</strong>
              <small>{{ session.provider || 'Unknown agent' }}{{ session.child ? ' · Subagent' : '' }}</small>
            </button>
          </td>
          <td :title="sessionProject(session)">
            {{ projectDisplay(sessionProject(session), store.projects) }}
            <small>{{ session.runId || 'Independent session' }}</small>
          </td>
          <td>
            <span :class="['state-pill', { working: ['working', 'running'].includes(session.state) }]">
              {{ session.state }}
            </span>
          </td>
          <td class="tabular">{{ duration(session.seconds) }}</td>
          <td class="tabular">{{ duration(session.observedSeconds) }}</td>
          <td>{{ session.proof }}</td>
        </tr>
        <tr v-if="store.summaryLoaded && !store.visibleSessions.length">
          <td colspan="6" class="table-empty">No agent sessions for this day{{ store.project === 'all' ? '' : ' in this project' }}.</td>
        </tr>
      </tbody>
    </table>
    <div v-if="store.visibleSessions.length > tableLimit" class="more-rows">
      <span>Showing {{ tableLimit }} of {{ store.visibleSessions.length }} sessions</span>
      <button class="btn btn-sm" @click="tableLimit += 100">Show 100 more</button>
    </div>
  </div>
</template>

<style>
.sessions-table .session-open {
  padding: 0;
  text-align: left;
  color: inherit;
}
.sessions-table tbody tr {
  cursor: pointer;
}
.sessions-table tbody tr.focused {
  background: var(--accent-soft);
}
</style>
