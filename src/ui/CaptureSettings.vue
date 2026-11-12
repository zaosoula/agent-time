<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { SwitchRoot, SwitchThumb, TabsRoot, TabsList, TabsTrigger, TabsContent } from 'reka-ui';
import {
  Bot,
  Layers3,
  ShieldCheck,
  ArrowUpRight,
  FolderKanban,
  Settings2,
  Lock,
  Database,
  Wrench,
} from '@lucide/vue';
import HookSetup from './HookSetup.vue';
import TrackingCleanup from './TrackingCleanup.vue';
import PrivacyExclusions from './PrivacyExclusions.vue';
import ArchiveExport from './ArchiveExport.vue';
import StorageUsage from './StorageUsage.vue';
import BillingSettings from './BillingSettings.vue';
import { useStore } from './store.ts';
const store = useStore();
import WebsiteRules from './WebsiteRules.vue';
import LinearConnection from './LinearConnection.vue';
import {
  native,
  openAccessibilitySettings,
  relaunchHookSetup,
  startupItem,
  type StartupItemStatus,
  type CaptureStatus,
} from './transport.ts';
import type { CaptureSettings } from '../capture/settings.ts';
import { humanizeError } from './errors.ts';
const props = defineProps<{ status: CaptureStatus | null; busy: boolean }>();
const emit = defineEmits<{ change: [settings: Partial<CaptureSettings>]; error: [cause: unknown] }>();
const tabs = [
  { id: 'general', title: 'General', icon: Settings2 },
  { id: 'agents', title: 'Agents', icon: Bot },
  { id: 'sources', title: 'Sources', icon: Layers3 },
  { id: 'projects', title: 'Projects & rules', icon: FolderKanban },
  { id: 'billing', title: 'Billing', icon: FolderKanban },
  { id: 'privacy', title: 'Privacy', icon: Lock },
  { id: 'data', title: 'Data & backup', icon: Database },
  { id: 'advanced', title: 'Advanced', icon: Wrench },
] as const;
const tabKey = 'agent-time.settings-tab';
const savedTab = sessionStorage.getItem(tabKey);
const active = ref<string>(tabs.some((tab) => tab.id === savedTab) ? savedTab! : 'general');
const visitedTabs = ref(new Set([active.value]));
store.settingsSection.value = active.value;
watch(active, (value) => {
  visitedTabs.value.add(value);
  store.settingsSection.value = value;
  sessionStorage.setItem(tabKey, value);
});
const agents = computed(() => props.status?.sources.filter((source) => source.kind === 'agent') || []);
const pollers = computed(() => props.status?.sources.filter((source) => source.kind === 'poller') || []);
const providers = computed(() => agents.value.map((source) => source.id));
const agent = (id: string) => agents.value.find((source) => source.id === id);
const browsers = computed(
  () =>
    props.status?.sources
      .filter((source) => source.kind === 'browser')
      .map((source) => ({
        key: source.setting,
        name: source.name,
        detail: source.detail || source.name,
        initial: source.name[0],
        tone: source.id,
      })) || [],
);
const hooksEnabled = computed(
  () => agents.value.filter((source) => props.status?.surfaces[source.setting]).length,
);
const usageEnabled = (id: string) =>
  Boolean(props.status?.surfaces.tokenUsage && props.status.surfaces[agent(id)?.usageSetting || '']);
const usageCount = computed(() => providers.value.filter(usageEnabled).length);
const allHookSettings = (enabled: boolean) =>
  Object.fromEntries(agents.value.map((source) => [source.setting, enabled]));
const allUsageSettings = (enabled: boolean) => ({
  tokenUsage: enabled,
  ...Object.fromEntries(agents.value.map((source) => [source.usageSetting, enabled])),
});
const idlePresets = [1, 2, 3, 5, 10, 15, 30, 60];
/** Preset choices, plus the current value when it was set to something else earlier. */
function idleChoices(current: number | undefined) {
  return current && !idlePresets.includes(current)
    ? [...idlePresets, current].sort((a, b) => a - b)
    : idlePresets;
}
const idleLabel = (minutes: number) =>
  minutes === 60 ? '1 hour' : `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
const startup = ref<StartupItemStatus | null>(null),
  startupBusy = ref(false),
  startupError = ref('');
async function refreshStartup() {
  if (!native) return;
  try {
    startup.value = await startupItem('status');
    startupError.value = '';
  } catch (error) {
    startupError.value = humanizeError(error);
  }
}
async function changeStartup(enabled: boolean) {
  startupBusy.value = true;
  startupError.value = '';
  try {
    startup.value = await startupItem(enabled ? 'enable' : 'disable');
  } catch (error) {
    startupError.value = humanizeError(error);
  } finally {
    startupBusy.value = false;
  }
}
async function openStartupSettings() {
  try {
    await startupItem('settings');
  } catch (error) {
    startupError.value = humanizeError(error);
  }
}
function setUsage(provider: string, enabled: boolean) {
  emit('change', {
    tokenUsage: true,
    ...Object.fromEntries(agents.value.map((source) => [source.usageSetting, usageEnabled(source.id)])),
    [agent(provider)?.usageSetting || '']: enabled,
  });
}
function setIdle(kind: 'humanIdleMinutes' | 'agentIdleMinutes', event: Event) {
  emit('change', { [kind]: Number((event.target as HTMLSelectElement).value) });
}
async function openPermission() {
  try {
    await openAccessibilitySettings();
  } catch (e) {
    emit('error', e);
  }
}
onMounted(() => {
  void refreshStartup();
  window.addEventListener('focus', refreshStartup);
});
onUnmounted(() => window.removeEventListener('focus', refreshStartup));
</script>
<template>
  <TabsRoot v-model="active" orientation="vertical" class="settings-layout" :unmount-on-hide="false">
    <nav class="settings-sidebar" aria-label="Settings sections">
      <h1>Settings</h1>
      <TabsList class="settings-tabs" aria-label="Settings sections">
        <TabsTrigger v-for="tab in tabs" :key="tab.id" :value="tab.id" class="settings-nav">
          <component :is="tab.icon" :size="16" /><span>{{ tab.title }}</span>
        </TabsTrigger>
      </TabsList>
      <p>General preferences save automatically. Save billing edits in their form.</p>
    </nav>
    <div class="settings-document">
      <TabsContent v-if="visitedTabs.has('general')" value="general" class="settings-panel">
        <section class="settings-section">
          <h2>General</h2>
          <p class="section-intro">How Agent Time starts and when it stops counting.</p>
          <div class="control-list">
            <div class="control-row">
              <div class="control-copy">
                <label id="startup-label" for="startup-item"
                  ><strong>Start capture when I sign in</strong></label
                >
                <p>
                  Start Agent Time in the menu bar with the dashboard hidden. Capture continues while the
                  window is closed.
                </p>
                <small>{{
                  !native
                    ? 'Available in the packaged Mac app'
                    : !startup
                      ? 'Checking login item…'
                      : startup.status === 'enabled'
                        ? 'On · starts at login'
                        : startup.status === 'requiresApproval'
                          ? 'Needs approval in macOS Login Items'
                          : 'Off · open Agent Time to capture'
                }}</small>
              </div>
              <SwitchRoot
                id="startup-item"
                aria-labelledby="startup-label"
                class="surface-switch"
                :model-value="startup?.status === 'enabled'"
                :disabled="!native || !startup || startupBusy"
                @update:model-value="changeStartup($event)"
                ><SwitchThumb class="surface-thumb"
              /></SwitchRoot>
            </div>
            <div v-if="startup?.status === 'requiresApproval' || startupError" class="startup-note">
              <p v-if="startupError" role="alert">{{ startupError }}</p>
              <button
                v-if="startup?.status === 'requiresApproval'"
                class="btn btn-sm"
                @click="openStartupSettings"
              >
                Open Login Items <ArrowUpRight :size="13" />
              </button>
            </div>
            <div class="control-row">
              <div class="control-copy">
                <label for="agent-idle"><strong>Stop counting agent time after</strong></label>
                <p>Agent time pauses after this long without any agent activity.</p>
              </div>
              <select
                id="agent-idle"
                class="idle-select"
                :value="status?.surfaces.agentIdleMinutes ?? 5"
                :disabled="busy || !status"
                @change="setIdle('agentIdleMinutes', $event)"
              >
                <option
                  v-for="minutes in idleChoices(status?.surfaces.agentIdleMinutes)"
                  :key="minutes"
                  :value="minutes"
                >
                  {{ idleLabel(minutes) }}
                </option>
              </select>
            </div>
            <div class="control-row">
              <div class="control-copy">
                <label for="human-idle"><strong>Stop counting my time after</strong></label>
                <p>Mac activity pauses after this long without keyboard or mouse input.</p>
              </div>
              <select
                id="human-idle"
                class="idle-select"
                :value="status?.surfaces.humanIdleMinutes ?? 5"
                :disabled="busy || !status"
                @change="setIdle('humanIdleMinutes', $event)"
              >
                <option
                  v-for="minutes in idleChoices(status?.surfaces.humanIdleMinutes)"
                  :key="minutes"
                  :value="minutes"
                >
                  {{ idleLabel(minutes) }}
                </option>
              </select>
            </div>
            <div class="control-row">
              <div class="control-copy">
                <label id="count-counters-label" for="count-counters"
                  ><strong>Count agent task counters as agent time</strong></label
                >
                <p>
                  Time between an agent's start_task and stop_task counts for its project. Only time not
                  already measured is added, so nothing is counted twice.
                </p>
              </div>
              <SwitchRoot
                id="count-counters"
                aria-labelledby="count-counters-label"
                class="surface-switch"
                :model-value="Boolean(status?.surfaces.countTaskCounters)"
                :disabled="busy || !status"
                @update:model-value="emit('change', { countTaskCounters: $event })"
                ><SwitchThumb class="surface-thumb"
              /></SwitchRoot>
            </div>
          </div>
          <footer class="settings-footnote">
            <p>Changes apply immediately. Existing history is kept.</p>
            <p>Closing the window keeps capture running. Quit Agent Time to stop it.</p>
          </footer>
        </section>
      </TabsContent>

      <TabsContent v-if="visitedTabs.has('agents')" value="agents" class="settings-panel">
        <HookSetup mode="settings">
          <template #global-controls>
            <div class="control-list">
              <div class="control-row">
                <div class="control-copy">
                  <label id="all-hooks-label" for="all-hooks"
                    ><strong>Hook capture for all agents</strong></label
                  >
                  <p>Receive session, tool and subagent events from connected agents.</p>
                  <small>{{ hooksEnabled }} of {{ providers.length }} agents on</small>
                </div>
                <SwitchRoot
                  id="all-hooks"
                  aria-labelledby="all-hooks-label"
                  class="surface-switch"
                  :model-value="hooksEnabled === providers.length"
                  :disabled="busy || !status"
                  @update:model-value="emit('change', allHookSettings($event))"
                  ><SwitchThumb class="surface-thumb"
                /></SwitchRoot>
              </div>
              <div class="control-row">
                <div class="control-copy">
                  <label id="all-usage-label" for="all-usage"
                    ><strong>Tokens &amp; usage for all agents</strong></label
                  >
                  <p>Scan local token counters, API-equivalent cost and available account limits.</p>
                  <small>{{ usageCount }} of {{ providers.length }} agents on</small>
                </div>
                <SwitchRoot
                  id="all-usage"
                  aria-labelledby="all-usage-label"
                  class="surface-switch"
                  :model-value="usageCount === providers.length"
                  :disabled="busy || !status"
                  @update:model-value="emit('change', allUsageSettings($event))"
                  ><SwitchThumb class="surface-thumb"
                /></SwitchRoot>
              </div>
            </div>
          </template>
          <template v-for="p in providers" :key="p" #[`${p}-controls`]>
            <div class="control-list">
              <div class="control-row">
                <div class="control-copy">
                  <label :id="p + '-capture-label'" :for="p + '-capture'"
                    ><strong>Capture session hooks</strong></label
                  >
                  <p>Track session activity, tools and native subagents.</p>
                  <small>{{
                    status?.surfaces[agent(p)?.setting || '']
                      ? status.running
                        ? 'Capture on'
                        : 'On · capture paused'
                      : 'Capture off'
                  }}</small>
                </div>
                <SwitchRoot
                  :id="p + '-capture'"
                  :aria-labelledby="p + '-capture-label'"
                  class="surface-switch"
                  :model-value="Boolean(status?.surfaces[agent(p)?.setting || ''])"
                  :disabled="busy || !status"
                  @update:model-value="emit('change', { [agent(p)?.setting || '']: $event })"
                  ><SwitchThumb class="surface-thumb"
                /></SwitchRoot>
              </div>
              <div class="control-row">
                <div class="control-copy">
                  <label :id="p + '-usage-label'" :for="p + '-usage'"
                    ><strong>Tokens &amp; usage</strong></label
                  >
                  <p>Read usage from captured {{ agent(p)?.name }} sessions and available account limits.</p>
                  <small
                    >{{
                      usageEnabled(p)
                        ? status?.running
                          ? 'Scanning on'
                          : 'On · capture paused'
                        : 'Scanning off'
                    }}
                    · imported history is kept</small
                  >
                </div>
                <SwitchRoot
                  :id="p + '-usage'"
                  :aria-labelledby="p + '-usage-label'"
                  class="surface-switch"
                  :model-value="usageEnabled(p)"
                  :disabled="busy || !status"
                  @update:model-value="setUsage(p, $event)"
                  ><SwitchThumb class="surface-thumb"
                /></SwitchRoot>
              </div>
            </div>
          </template>
        </HookSetup>
      </TabsContent>

      <TabsContent v-if="visitedTabs.has('sources')" value="sources" class="settings-panel">
        <section class="settings-section">
          <h2>Sources</h2>
          <p class="section-intro">Where Agent Time looks for activity besides agent hooks.</p>
          <h3 class="subsection-title">Coding environments</h3>
          <div class="control-list">
            <div v-for="source in pollers" :key="source.id" class="control-row">
              <div class="control-copy">
                <label :id="source.id + '-label'" :for="source.id + '-polling'"
                  ><strong>Discover {{ source.name }} sessions</strong></label
                >
                <p>
                  {{
                    source.id === 'orca'
                      ? 'Discover terminals and orchestration runs, and sample worker activity. Overlap with hooks is counted once. Orca account hooks are managed under Agents.'
                      : `Collect session metadata from ${source.name}.`
                  }}
                </p>
                <small>{{
                  !status
                    ? 'Checking discovery…'
                    : source.id === 'orca' && !status.orcaAvailable
                      ? 'Orca not installed · discovery skipped'
                      : status.surfaces[source.setting]
                        ? status.running
                          ? 'Discovery on'
                          : 'On · capture paused'
                        : 'Discovery off'
                }}</small>
              </div>
              <SwitchRoot
                :id="source.id + '-polling'"
                :aria-labelledby="source.id + '-label'"
                class="surface-switch"
                :model-value="Boolean(status?.surfaces[source.setting])"
                :disabled="busy || !status"
                @update:model-value="emit('change', { [source.setting]: $event })"
                ><SwitchThumb class="surface-thumb"
              /></SwitchRoot>
            </div>
            <p v-if="!pollers.length" class="control-empty">No coding environments detected yet.</p>
          </div>

          <h3 class="subsection-title">Mac activity</h3>
          <div class="control-list">
            <div class="control-row">
              <div class="control-copy">
                <label id="macos-label" for="macos-activity"><strong>Track Mac activity</strong></label>
                <p>
                  Foreground app, input idle time, and sleep or wake. Your time stays separate from agent
                  time.
                </p>
                <small>{{
                  status?.surfaces.macosActivity
                    ? status.running
                      ? 'Tracking on'
                      : 'On · capture paused'
                    : 'Tracking off'
                }}</small>
              </div>
              <SwitchRoot
                id="macos-activity"
                aria-labelledby="macos-label"
                class="surface-switch"
                :model-value="status?.surfaces.macosActivity ?? false"
                :disabled="busy || !status"
                @update:model-value="emit('change', { macosActivity: $event })"
                ><SwitchThumb class="surface-thumb"
              /></SwitchRoot>
            </div>
          </div>
          <div class="permission-card">
            <ShieldCheck :size="19" />
            <div>
              <h3>Accessibility permission</h3>
              <strong>{{
                !status?.surfaces.macosActivity
                  ? 'Mac activity tracking is off'
                  : !status.macos
                    ? 'Checking permission…'
                    : status.macos.accessibilityTrusted
                      ? 'Granted'
                      : 'Not granted · basic activity available'
              }}</strong>
              <p>
                Foreground app and idle tracking work without Accessibility. Grant it to identify Orca’s
                selected terminal tab and the active website. Unmatched activity stays in your overall total.
              </p>
              <button v-if="native" class="btn btn-sm" @click="openPermission">
                Open System Settings <ArrowUpRight :size="13" />
              </button>
              <p v-else>Manage permission in System Settings → Privacy &amp; Security → Accessibility.</p>
            </div>
          </div>

          <h3 class="subsection-title">Browsers</h3>
          <p class="section-intro">
            Choose which browser tabs Agent Time may read. Website activity stores the active page’s full URL,
            including its path and query, and its title on this Mac.
          </p>
          <div class="browser-list">
            <div v-for="browser in browsers" :key="browser.key" class="browser-row">
              <span :class="['browser-mark', browser.tone]" aria-hidden="true">{{ browser.initial }}</span>
              <div class="control-copy">
                <label :id="browser.key + '-label'" :for="browser.key"
                  ><strong>{{ browser.name }}</strong></label
                >
                <p>{{ browser.detail }} · active tab only</p>
                <small>{{
                  !status?.surfaces[browser.key]
                    ? 'Website capture off'
                    : !status.surfaces.macosActivity
                      ? 'On · Mac activity tracking is off'
                      : !status.macos?.accessibilityTrusted
                        ? 'On · Accessibility needed'
                        : status.running
                          ? 'Website capture on'
                          : 'On · capture paused'
                }}</small>
              </div>
              <SwitchRoot
                :id="browser.key"
                :aria-labelledby="browser.key + '-label'"
                class="surface-switch"
                :model-value="status?.surfaces[browser.key] ?? false"
                :disabled="busy || !status"
                @update:model-value="emit('change', { [browser.key]: $event })"
                ><SwitchThumb class="surface-thumb"
              /></SwitchRoot>
            </div>
          </div>
          <p class="section-note">
            Turning a browser off stops collecting its page details. Existing history remains available.
          </p>
        </section>
      </TabsContent>

      <TabsContent v-if="visitedTabs.has('projects')" value="projects" class="settings-panel">
        <section class="settings-section">
          <h2>Projects &amp; rules</h2>
          <p class="section-intro">
            Connect Linear repository links, review websites assigned to each project, and add exact matching
            rules.
          </p>
          <LinearConnection />
          <WebsiteRules />
        </section>
      </TabsContent>

      <TabsContent v-if="visitedTabs.has('billing')" value="billing" class="settings-panel">
        <BillingSettings />
      </TabsContent>

      <TabsContent v-if="visitedTabs.has('privacy')" value="privacy" class="settings-panel">
        <section class="settings-section">
          <h2>Privacy</h2>
          <p class="section-intro">
            Everything stays on this Mac. Exclude apps and sites you never want sampled.
          </p>
          <PrivacyExclusions />
        </section>
      </TabsContent>

      <TabsContent v-if="visitedTabs.has('data')" value="data" class="settings-panel">
        <section class="settings-section">
          <h2>Data &amp; backup</h2>
          <p class="section-intro">Storage used on this Mac, archives and restores.</p>
          <StorageUsage :running="Boolean(status?.running)" :limit="status?.surfaces.storageLimitMB" @change="emit('change',$event)" />
          <ArchiveExport :running="Boolean(status?.running)" />
          <h3 class="subsection-title danger-title">Danger zone</h3>
          <TrackingCleanup />
        </section>
      </TabsContent>

      <TabsContent v-if="visitedTabs.has('advanced')" value="advanced" class="settings-panel">
        <section class="settings-section">
          <h2>Advanced</h2>
          <p class="section-intro">Setup and troubleshooting.</p>
          <div class="control-list">
            <div class="control-row">
              <div class="control-copy">
                <strong>Setup assistant</strong>
                <p>Run the agent hook setup again, for example after installing a new agent.</p>
              </div>
              <button class="btn" @click="relaunchHookSetup">Run setup assistant</button>
            </div>
            <div class="control-row">
              <div class="control-copy">
                <strong>Disabled hooks</strong>
                <p>Events received from agents whose hook capture is off are discarded, not stored.</p>
              </div>
            </div>
          </div>
        </section>
      </TabsContent>
    </div>
  </TabsRoot>
</template>
<style scoped>
.settings-layout {
  display: flex;
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}
.settings-sidebar {
  width: 176px;
  flex-shrink: 0;
  padding: 30px 14px;
  background: var(--bg);
  border-right: 1px solid var(--border);
  overflow: auto;
}
.settings-sidebar h1 {
  font-size: 17px;
  margin: 0 10px 24px;
  letter-spacing: -0.35px;
}
.settings-tabs {
  display: grid;
  gap: 2px;
}
.settings-nav {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  color: var(--muted);
  padding: 8px 10px;
  border-radius: 6px;
  text-align: left;
  font-size: var(--text-sm);
}
.settings-nav[data-state='active'] {
  background: var(--selected);
  color: var(--selected-text);
  font-weight: 550;
}
.settings-nav:hover:not([data-state='active']) {
  background: var(--hover);
}
.settings-sidebar > p {
  font-size: var(--text-xs);
  line-height: 1.6;
  color: var(--muted);
  margin: 24px 10px;
}
.settings-document {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  padding: 30px 30px 36px;
  position: relative;
}
.settings-section {
  margin-bottom: 38px;
  scroll-margin-top: 24px;
  outline: none;
}
.settings-panel {
  outline: none;
}
.settings-panel[hidden] {
  display: none;
}
.subsection-title {
  margin: 26px 0 10px;
  font-size: var(--text-md);
  font-weight: 650;
}
.danger-title {
  color: var(--status-danger);
}
.control-empty {
  margin: 0;
  padding: 16px 20px;
  color: var(--muted);
  font-size: var(--text-sm);
}
.settings-section h2 {
  font-size: var(--text-xl);
  letter-spacing: -0.35px;
  margin: 0 0 8px;
}
.section-intro {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.6;
  margin: 0 0 18px;
}
.control-list {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
  overflow: hidden;
}
.control-row {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 18px 20px;
  border-bottom: 1px solid var(--border);
}
.control-row:last-child {
  border: 0;
}
.control-copy {
  flex: 1;
  min-width: 0;
}
.control-copy strong {
  font-size: 13px;
}
.control-copy p,
.permission-card p {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.6;
  margin: 6px 0;
}
.control-copy small {
  font-size: var(--text-xs);
  color: var(--muted);
}
.surface-switch {
  width: 36px;
  height: 21px;
  border-radius: 20px;
  background: var(--border);
  padding: 2px;
  flex-shrink: 0;
  transition: background 0.15s;
}
.surface-switch[data-state='checked'] {
  background: var(--blue);
}
.surface-thumb {
  display: block;
  width: 17px;
  height: 17px;
  background: white;
  border-radius: 50%;
  box-shadow: 0 1px 3px #0003;
  transition: transform 0.15s;
}
.surface-thumb[data-state='checked'] {
  transform: translateX(15px);
}
.browser-list {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
  overflow: hidden;
}
.browser-row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 15px 20px;
  border-bottom: 1px solid var(--border);
}
.browser-row:last-child {
  border: 0;
}
.browser-mark {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 9px;
  flex: none;
  font-size: 17px;
  font-weight: 700;
  letter-spacing: -1px;
}
.browser-mark.safari {
  color: var(--accent);
  background: var(--accent-soft);
}
.browser-mark.chrome {
  color: var(--status-good);
  background: var(--status-good-soft);
}
.browser-mark.brave {
  color: var(--status-danger);
  background: var(--status-danger-soft);
}
.permission-card {
  display: flex;
  gap: 14px;
  margin-top: 16px;
  padding: 20px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
}
.permission-card > svg {
  color: var(--muted);
  flex-shrink: 0;
}
.permission-card h3 {
  font-size: 13px;
  margin: 0 0 8px;
}
.permission-card strong {
  font-size: 11px;
  font-weight: 500;
}
.permission-card .btn {
  margin-top: 6px;
}
.section-note,
.settings-footnote {
  font-size: 11px;
  color: var(--muted);
  line-height: 1.6;
  margin-top: 16px;
}
.settings-footnote p {
  margin: 6px 0;
}
.settings-nav:focus-visible,
.surface-switch:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: 3px;
}
@media (max-width: 1050px) {
  .settings-sidebar {
    width: 145px;
    padding-inline: 10px;
  }
  .settings-document {
    padding-inline: 22px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .surface-switch,
  .surface-thumb {
    transition: none;
  }
}
.idle-select {
  flex: none;
  min-width: 115px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  color: var(--text);
  padding: 7px 9px;
  font: inherit;
  font-size: 12px;
}
.idle-select:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: 3px;
}
.idle-select:disabled {
  opacity: 0.5;
}
.startup-list {
  margin-top: 16px;
}
.startup-note {
  padding: 0 20px 16px;
  font-size: 12px;
}
.startup-note p {
  color: var(--status-danger);
  margin: 0 0 8px;
}
</style>
