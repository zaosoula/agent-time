<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { ArrowUpRight, RefreshCw, Link2 } from '@lucide/vue';
import { transport, type LinearConnectionStatus } from './transport.ts';
import { useStore } from './store.ts';
import { windowVisible } from './polling.ts';
import { humanizeError } from './errors.ts';
import { clearToast, toast } from './toast.ts';
import { dateTime } from './format.ts';

const store = useStore();
const status = ref<LinearConnectionStatus | null>(null),
  busy = ref(false),
  error = ref('');
const rules = computed(() => store.websiteProjects.value?.rules || []);
let timer: ReturnType<typeof setTimeout> | undefined,
  unmounted = false;
const name = (path: string) => path.split('/').filter(Boolean).at(-1) || path;
function localPaths(project: { repositories: string[] }) {
  return [...new Set(project.repositories.flatMap((repo) => status.value?.repositoryMatches[repo] || []))];
}
function ruleFor(site: string) {
  return rules.value.find((rule) => rule.pattern === site);
}
async function refresh() {
  try {
    const [next] = await Promise.all([
      transport.linearStatus(),
      store.websiteProjects.value ? Promise.resolve() : store.refreshWebsiteProjects(),
    ]);
    if (!unmounted) {
      status.value = next;
      error.value = '';
    }
  } catch (e) {
    if (!unmounted) error.value = humanizeError(e);
  }
  schedule();
}
/** While waiting for browser sign-in, check every 2.5s, and only while the window is visible. */
function schedule() {
  clearTimeout(timer);
  timer = undefined;
  if (unmounted || !windowVisible.value || status.value?.phase !== 'connecting') return;
  timer = setTimeout(() => {
    if (!busy.value) void refresh();
    else schedule();
  }, 2500);
}
watch(windowVisible, (shown) => {
  if (shown) void refresh();
  else clearTimeout(timer);
});
async function run(action: () => Promise<unknown>, success?: string) {
  busy.value = true;
  try {
    await action();
    clearToast('linear');
    if (success) toast.success(success);
  } catch (e) {
    toast.error(e, 'linear');
  } finally {
    await refresh();
    busy.value = false;
  }
}
const connect = () => run(() => transport.linearConnect(status.value!.clientId));
const sync = (workspaceId?: string) => run(() => transport.linearSync(workspaceId), 'Linear synced.');
const disconnect = (workspaceId?: string) =>
  run(
    () => transport.linearDisconnect(workspaceId),
    status.value?.phase === 'connecting' ? undefined : 'Linear workspace disconnected.',
  );
async function assign(site: string, project: { repositories: string[] }) {
  const paths = localPaths(project);
  if (paths.length !== 1) return;
  await run(
    async () => {
      const existing = (await store.refreshWebsiteProjects()).rules.find((rule) => rule.pattern === site);
      if (existing && existing.projectPath !== paths[0])
        throw new Error(
          `This site already belongs to ${name(existing.projectPath)}. Review that rule first.`,
        );
      if (!existing) store.websiteProjects.value = await transport.setWebsiteRule(site, paths[0]);
    },
    `${site} now counts toward ${name(paths[0])}.`,
  );
}
onMounted(() => void refresh());
onUnmounted(() => {
  unmounted = true;
  clearTimeout(timer);
});
</script>
<template>
  <div class="linear-card">
    <div class="linear-heading">
      <div>
        <h3><Link2 :size="16" /> Linear</h3>
        <p>
          Connect your workspaces to match project Resources with tracked repositories. Agent Time requests
          read-only access.
        </p>
      </div>
      <span :class="['linear-state', status?.phase]">{{
        !status
          ? 'Checking connection…'
          : status.phase === 'connecting'
            ? 'Waiting for sign-in'
            : status.workspaces.length
              ? `${status.workspaces.length} connected`
              : status.phase === 'error'
                ? 'Needs attention'
                : 'Not connected'
      }}</span>
    </div>
    <div class="linear-actions">
      <p>Linear uses the active workspace in your browser. Switch there first to add a different one.</p>
      <button :disabled="busy || !status || status.phase === 'connecting'" @click="connect">
        {{ status?.phase === 'connecting' ? 'Waiting for browser…' : 'Add Linear workspace' }}</button
      ><button v-if="status?.phase === 'connecting'" :disabled="busy" @click="disconnect()">Cancel</button
      ><button v-if="status?.workspaces.length" :disabled="busy" @click="sync()">
        <RefreshCw :size="13" /> Sync all
      </button>
    </div>
    <section
      v-for="workspace in status?.workspaces || []"
      :key="workspace.workspaceId"
      class="linear-workspace"
    >
      <div class="linear-actions">
        <p>
          <strong>{{ workspace.workspaceName }}</strong> · {{ workspace.viewerName || 'Linear user' }} ·
          {{ workspace.projects.length }} projects ·
          {{ workspace.syncedAt ? `synced ${dateTime(workspace.syncedAt)}` : 'not synced yet' }}
        </p>
        <button :disabled="busy" @click="sync(workspace.workspaceId)"><RefreshCw :size="13" /> Sync</button
        ><button :disabled="busy" @click="disconnect(workspace.workspaceId)">Disconnect</button>
      </div>
      <p v-if="workspace.error" class="linear-error">{{ workspace.error }}</p>
      <details v-if="workspace.projects.length" class="linear-project-list">
        <summary>
          Review {{ workspace.projects.length }}
          {{ workspace.projects.length === 1 ? 'project' : 'projects' }} and Resource links
        </summary>
        <div class="linear-projects">
          <article v-for="project in workspace.projects" :key="project.id">
            <a :href="project.url" target="_blank" rel="noopener noreferrer"
              >{{ project.name }} <ArrowUpRight :size="12"
            /></a>
            <div v-if="project.repositories.length" class="linear-links">
              <span v-for="repo in project.repositories" :key="repo"
                ><code>{{ repo }}</code
                ><small v-if="status?.repositoryMatches[repo]?.length"
                  >→ {{ status.repositoryMatches[repo].map(name).join(', ') }}</small
                ><small v-else>Local clone not matched</small></span
              >
            </div>
            <p v-else>No repository Resource link found.</p>
            <div v-if="project.sites.length" class="linear-sites">
              <span v-for="site in project.sites" :key="site"
                ><code>{{ site }}</code
                ><small v-if="ruleFor(site)">Rule: {{ name(ruleFor(site)!.projectPath) }}</small
                ><button
                  v-else-if="localPaths(project).length === 1"
                  :disabled="busy"
                  @click="assign(site, project)"
                >
                  Use as rule for {{ name(localPaths(project)[0]) }}</button
                ><small v-else>Review the local project match before assigning</small></span
              >
            </div>
            <p v-if="project.linksIncomplete">
              More Resources exist in Linear; this project needs a fuller sync.
            </p>
          </article>
        </div>
      </details>
    </section>
    <p v-if="error || status?.error" class="linear-error" role="alert">{{ error || status?.error }}</p>
  </div>
</template>
<style scoped>
.linear-card {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
  padding: 18px 20px;
  margin: 0 0 20px;
}
.linear-heading,
.linear-actions {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}
.linear-heading h3 {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  margin: 0;
}
.linear-heading p,
.linear-actions p,
.linear-setup,
.linear-projects p {
  font-size: 11px;
  color: var(--muted);
  line-height: 1.55;
  margin: 6px 0;
}
.linear-state {
  font-size: var(--text-xs);
  color: var(--muted);
  white-space: nowrap;
}
.linear-state.connected {
  color: var(--status-good);
}
.linear-state.error {
  color: var(--status-warning);
}
.linear-setup {
  margin-top: 16px;
}
.linear-setup a,
.linear-projects a {
  color: var(--blue);
  text-decoration: none;
}
.linear-setup a svg,
.linear-projects a svg {
  vertical-align: middle;
}
.linear-setup code {
  display: inline-block;
  overflow-wrap: anywhere;
  padding: 2px 4px;
  border-radius: 4px;
  background: var(--hover);
  color: var(--text);
}
.linear-form {
  margin-top: 14px;
}
.linear-form label {
  display: block;
  color: var(--muted);
  font-size: var(--text-xs);
  margin-bottom: 7px;
}
.linear-form > div {
  display: flex;
  gap: 8px;
}
.linear-form input {
  min-width: 0;
  flex: 1;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  padding: 8px 10px;
  color: var(--text);
  font: inherit;
  font-size: 11px;
}
.linear-form button,
.linear-actions button {
  border-radius: 6px;
  background: var(--blue);
  color: white;
  padding: 8px 10px;
  font-size: var(--text-xs);
  white-space: nowrap;
}
.linear-form button:disabled,
.linear-actions button:disabled {
  opacity: 0.5;
}
.linear-actions {
  align-items: center;
  margin-top: 14px;
}
.linear-actions p {
  flex: 1;
}
.linear-actions button:last-child {
  background: var(--hover);
  color: var(--text);
}
.linear-actions button svg {
  vertical-align: middle;
  margin-right: 3px;
}
.linear-projects {
  max-height: 260px;
  overflow: auto;
  border-top: 1px solid var(--border);
  margin-top: 15px;
}
.linear-projects article {
  padding: 12px 0;
  border-bottom: 1px solid var(--border);
}
.linear-projects article:last-child {
  border: 0;
}
.linear-projects a {
  font-size: 11px;
  font-weight: 600;
}
.linear-links {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 7px;
}
.linear-links > span {
  display: flex;
  gap: 6px;
  align-items: center;
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 4px 6px;
  font-size: var(--text-xs);
}
.linear-links small {
  color: var(--muted);
}
.linear-error {
  color: var(--status-danger);
  font-size: 11px;
  overflow-wrap: anywhere;
}
.linear-form input:focus-visible,
.linear-form button:focus-visible,
.linear-actions button:focus-visible,
.linear-card a:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: 2px;
}
@media (max-width: 690px) {
  .linear-heading,
  .linear-actions {
    flex-wrap: wrap;
  }
  .linear-form > div {
    flex-direction: column;
  }
}
.linear-sites {
  display: grid;
  gap: 5px;
  margin-top: 10px;
}
.linear-sites > span {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  font-size: var(--text-xs);
}
.linear-sites code {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
}
.linear-sites small {
  color: var(--muted);
}
.linear-sites button {
  color: var(--blue);
  white-space: nowrap;
}
.linear-sites button:disabled {
  opacity: 0.5;
}
.linear-form button[type='button'] {
  background: var(--hover);
  color: var(--text);
}
.linear-setup button {
  color: var(--blue);
  font-size: inherit;
}
.linear-setup button svg {
  vertical-align: middle;
}
.linear-workspace {
  border-top: 1px solid var(--border);
  margin-top: 16px;
  padding-top: 4px;
}
.linear-project-list {
  margin-top: 12px;
}
.linear-project-list summary {
  cursor: pointer;
  color: var(--blue);
  font-size: 11px;
}
.linear-project-list summary:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: 3px;
}
</style>
