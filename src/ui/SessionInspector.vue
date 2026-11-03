<script setup lang="ts">
import { reactive } from 'vue';
import { Bot, X } from '@lucide/vue';
import { useStore } from './store.ts';
import { duration } from './format.ts';
import { projectColor, projectDisplay, sessionProject, unassignedProject } from './project-identity.ts';

const store = reactive(useStore());
const workspacePath = (session: { cwd?: string; workspaceId?: string }) =>
  session.cwd || session.workspaceId?.split('::').at(-1) || unassignedProject;
</script>

<template>
  <aside v-if="store.selectedSession" class="inspector" aria-label="Session details">
    <div class="inspector-toolbar">
      <span>Session details</span>
      <button class="icon-button" aria-label="Close session details" @click="store.selectedSessionKey = ''">
        <X :size="16" />
      </button>
    </div>
    <span class="inspector-icon" :style="{ color: projectColor(sessionProject(store.selectedSession)) }">
      <Bot :size="27" />
    </span>
    <h2>{{ store.selectedSession.title }}</h2>
    <span class="state-pill">{{ store.selectedSession.state }}</span>
    <dl>
      <dt>Project</dt>
      <dd :title="sessionProject(store.selectedSession)">
        {{ projectDisplay(sessionProject(store.selectedSession), store.projects) }}
      </dd>
      <dt>Agent</dt>
      <dd>{{ store.selectedSession.provider || 'Unknown' }}</dd>
      <dt>Agent time</dt>
      <dd class="inspector-duration">{{ duration(store.selectedSession.seconds) }}</dd>
      <dt>Tool time</dt>
      <dd>{{ duration(store.selectedSession.observedSeconds) }}</dd>
      <dt>Evidence</dt>
      <dd>{{ store.selectedSession.proof }}</dd>
      <dt>Orchestration run</dt>
      <dd>{{ store.selectedSession.runId || 'Independent session' }}</dd>
      <dt>Task / attempt</dt>
      <dd>
        {{ store.selectedSession.taskId || 'Unassigned' }}<br />{{
          store.selectedSession.dispatchId || 'No dispatch'
        }}
      </dd>
      <dt>Provider session</dt>
      <dd>{{ store.selectedSession.sessionId || 'Not yet linked' }}</dd>
      <dt>Workspace</dt>
      <dd class="path">{{ workspacePath(store.selectedSession) }}</dd>
    </dl>
    <p class="inspector-note">
      Agent time counts completed turns, including the time between tool calls. Turns without a matching end
      are not counted. Subagent time is shown separately.
    </p>
  </aside>
</template>
