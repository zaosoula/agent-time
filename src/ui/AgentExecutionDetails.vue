<script setup lang="ts">
import type { AgentExecution } from './project-explorer.ts';
import { clock, duration } from './format.ts';
defineProps<{ execution: AgentExecution }>();
</script>

<template>
  <dl class="execution-detail">
    <dt>Agent</dt>
    <dd>{{ execution.session.provider || 'Unknown' }}{{ execution.session.agentId ? ` · ${execution.session.agentId}` : '' }}</dd>
    <dt>Measured time</dt>
    <dd>{{ duration(execution.seconds) }} · tool time {{ duration(execution.session.observedSeconds) }}</dd>
    <dt>Observed window</dt>
    <dd>{{ execution.start === null || execution.end === null ? 'No activity on this day' : `${clock(execution.start)}–${clock(execution.end)}` }}</dd>
    <dt>State</dt>
    <dd>{{ execution.session.state }} · evidence {{ execution.session.proof }}</dd>
    <template v-if="execution.session.runId || execution.session.taskId">
      <dt>Orchestration</dt>
      <dd>{{ execution.session.runId || 'No run' }} · {{ execution.session.taskId || 'No task' }}</dd>
    </template>
    <dt>Provider session</dt>
    <dd>{{ execution.session.sessionId || 'Not linked' }}</dd>
  </dl>
</template>

<style scoped>
.execution-detail { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 10px 16px; margin: 12px 10px; font-size: var(--text-sm); line-height: 1.5; }
dt { color: var(--muted); }
dd { margin: 0; overflow-wrap: anywhere; }
@media (max-width: 760px) { .execution-detail { grid-template-columns: 1fr; gap: 3px; margin: 16px 0; } dd { margin-bottom: 12px; } }
</style>
