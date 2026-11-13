<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import type { BillingProject } from '../capture/billing-types.ts';
import { request } from './transport.ts';
import { humanizeError } from './errors.ts';
import { useStore } from './store.ts';
import { projectDisplay, projectLabel, sessionProject } from './project-identity.ts';
import { duration, longDate } from './format.ts';
import { humanReviewState } from '../capture/human-review.ts';
import AppCard from './AppCard.vue';
import SectionHeading from './SectionHeading.vue';
import DayPicker from './DayPicker.vue';
import WebsiteRules from './WebsiteRules.vue';
import BillingSettings from './BillingSettings.vue';
import WorkOutcomes from './WorkOutcomes.vue';

const store = useStore();
const sections = [
  { id: 'overview', label: 'Overview' },
  { id: 'attribution', label: 'Attribution' },
  { id: 'billing', label: 'Billing' },
  { id: 'evidence', label: 'Evidence' },
] as const;
const visited = reactive(new Set<string>([store.projectsSection.value]));
watch(store.projectsSection, (section) => visited.add(section));
const configuredRepositories = ref<string[]>([]);
const catalogLoading = ref(false), catalogError = ref('');
async function refreshRepositoryCatalog() {
  if (catalogLoading.value) return;
  catalogLoading.value = true;
  try {
    const result = await request<{ projects: BillingProject[]; knownSources: string[] }>('billing_projects', {});
    configuredRepositories.value = [...new Set([
      ...result.projects.flatMap((group) => group.sources.repositories),
      ...result.knownSources,
    ])].filter((path) => path.startsWith('/'));
    catalogError.value = '';
  } catch (cause) {
    catalogError.value = humanizeError(cause);
  } finally {
    catalogLoading.value = false;
  }
}
onMounted(refreshRepositoryCatalog);
const repository = computed(() => store.project.value === 'all' ? '' : store.project.value);
const repositories = computed(() => [...new Set([
  ...store.projects.value,
  ...configuredRepositories.value,
  ...(store.websiteProjects.value?.projects || []),
  ...(store.websiteProjects.value?.rules.map((rule) => rule.projectPath) || []),
  ...(repository.value ? [repository.value] : []),
])].filter((path) => path.startsWith('/')).sort());
const folder = ref(''), folderError = ref('');
function chooseRepository(path: string) {
  store.navigate('projects', path || 'all');
  // Billing groups are a separate, explicit selection; a folder never chooses one.
}
function openFolder() {
  const path = folder.value.trim();
  if (!path.startsWith('/')) { folderError.value = 'Enter a full repository folder starting with /.'; return; }
  chooseRepository(path); folder.value = ''; folderError.value = '';
}
function openSection(section: typeof sections[number]['id']) { store.projectsSection.value = section; }
function openActivity() { store.navigate('today'); }
const overviewGroups = computed(() => store.timelineProjects.value.filter((group) => !repository.value || group.name === repository.value));
const overviewHumanSeconds = computed(() => overviewGroups.value.reduce((total, group) => total + group.humanSeconds, 0));
const overviewAgentSeconds = computed(() => overviewGroups.value.reduce((total, group) => total + group.agentSeconds, 0));
const overviewSessions = computed(() => store.creditedSessions.value.filter((session) => !repository.value || sessionProject(session) === repository.value));
const overviewReview = computed(() => store.appReviewGroups.value.filter((group) => !repository.value || group.projectPath === repository.value));
const overviewPendingReview = computed(() => overviewReview.value.filter((group) => ['unmatched', 'conflict'].includes(humanReviewState(group))));
const overviewHasActivity = computed(() => overviewHumanSeconds.value > 0 || overviewAgentSeconds.value > 0 || overviewSessions.value.length > 0 || overviewReview.value.length > 0);

</script>

<template>
  <section class="day-content app-page projects-page">
    <SectionHeading class="day-heading" title="Projects" description="Connect repository activity, website attribution and billing rules." :level="1" size="page"><template #actions><DayPicker /></template></SectionHeading>
    <AppCard class="repository-picker card" padding="compact">
      <label for="projects-repository">Repository</label>
      <select id="projects-repository" :value="repository" @change="chooseRepository(($event.target as HTMLSelectElement).value)">
        <option value="">All repositories · manage billing groups</option>
        <option v-for="path in repositories" :key="path" :value="path">{{ projectDisplay(path, repositories) }}</option>
      </select>
      <button class="btn btn-sm" :disabled="catalogLoading" @click="refreshRepositoryCatalog">{{ catalogLoading ? 'Loading repositories…' : 'Refresh repositories' }}</button>
      <p v-if="catalogError" role="status" class="catalog-error">Saved repository list could not be refreshed: {{ catalogError }}. You can still use the available choices or open a folder.</p>
      <details><summary>Open another repository</summary><form @submit.prevent="openFolder"><label for="projects-folder">Repository folder</label><input id="projects-folder" v-model="folder" placeholder="/Users/you/projects/app" /><button class="btn" type="submit">Open folder</button></form><p v-if="folderError" role="alert">{{ folderError }}</p></details>
      <p v-if="repository" class="repository-path">{{ repository }}</p>
    </AppCard>
    <nav class="workspace-tabs" aria-label="Project sections"><button v-for="section in sections" :key="section.id" :aria-current="store.projectsSection.value === section.id ? 'page' : undefined" :class="['workspace-tab', { active: store.projectsSection.value === section.id }]" @click="openSection(section.id)">{{ section.label }}</button></nav>
    <AppCard padding="spacious" v-if="visited.has('overview')" v-show="store.projectsSection.value === 'overview'" class="project-overview card">
      <SectionHeading :title="repository ? projectLabel(repository) : 'Your project workspace'" :description="longDate(store.selectedDate.value)" />
      <p v-if="!store.summaryLoaded.value" role="status">{{ store.pollError.value ? 'Activity could not be loaded. Try refreshing from Home.' : 'Loading activity for this day…' }}</p>
      <template v-else>
        <dl class="project-metrics"><div><dt>Human active time</dt><dd>{{ duration(overviewHumanSeconds) }}</dd></div><div><dt>Cumulative agent time</dt><dd>{{ duration(overviewAgentSeconds) }}</dd></div><div><dt>Agent sessions</dt><dd>{{ overviewSessions.length }}</dd></div><div><dt>Visits to review</dt><dd>{{ overviewPendingReview.length }}</dd></div></dl>
        <p v-if="!overviewHasActivity">No captured activity for this day{{ repository ? ' and repository' : '' }}.</p>
        <p v-else>{{ overviewReview.length }} captured app or website visits{{ repository ? ' attributed to this repository' : '' }}. <button class="text-link" @click="store.navigate('review')">Open Review</button></p>
        <p v-if="store.search.value">Time totals follow the current activity search filter “{{ store.search.value }}”.</p>
      </template>
      <p>{{ repository ? 'Explore activity and evidence for this repository, or configure its website rules.' : 'Choose a repository for attribution and evidence, or open Billing to manage all billing groups.' }}</p>
      <p>Repositories identify captured work. Billing groups explicitly combine registered sources and can include several repositories. Choosing a repository does not select or change a billing group.</p>
      <div class="project-actions"><button class="btn" @click="openActivity">View activity</button><button class="btn" @click="openSection('attribution')">Website attribution</button><button class="btn" @click="openSection('billing')">Manage billing groups</button><button class="btn" @click="openSection('evidence')">View evidence</button></div>
    </AppCard>
    <div v-if="visited.has('attribution')" v-show="store.projectsSection.value === 'attribution'">
      <p class="section-hint">Website rules affect future visits. Review existing activity from Review.</p>
      <WebsiteRules :project="repository || undefined" />
    </div>
    <div v-if="visited.has('billing')" v-show="store.projectsSection.value === 'billing'">
      <p class="section-hint">Choose a billing group below. Its registered sources define which repositories share its clock{{ repository ? `; selecting ${projectLabel(repository)} above does not change those sources` : '' }}.</p>
      <BillingSettings :selected-project-id="store.billingSettingsProject.value" @selected="store.billingSettingsProject.value = $event" />
    </div>
    <div v-if="visited.has('evidence')" v-show="store.projectsSection.value === 'evidence'"><WorkOutcomes :show-date-picker="false" :active="store.page.value === 'projects' && store.projectsSection.value === 'evidence'" /></div>
  </section>
</template>

<style scoped>
.projects-page { max-width: 1120px; }
.repository-picker { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.repository-picker > label { font-weight: 600; font-size: 12px; }
.repository-picker select { flex: 1; min-width: 200px; }
select, input { background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: var(--control-radius, 6px); min-height: var(--control-height, 32px); box-sizing: border-box; padding: var(--control-padding-block, 7px) var(--control-padding-inline, 10px); font: inherit; font-size: var(--control-font-size, 12px); line-height: var(--control-line-height, 16px); }
.catalog-error { width: 100%; color: var(--muted); font-size: 12px; line-height: 1.6; margin: 0; }
.repository-path { width: 100%; overflow-wrap: anywhere; margin: 0; color: var(--muted); font-size: 11px; }
summary { cursor: pointer; color: var(--muted); font-size: 12px; }
form { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; align-items: center; }
form label { font-size: 12px; }
.workspace-tabs { display: flex; gap: 5px; margin: 20px 0; border-bottom: 1px solid var(--border); }
.workspace-tabs button { padding: 10px 15px; color: var(--muted); border-bottom: 2px solid transparent; font-size: 12px; }
.workspace-tabs button.active { color: var(--text); border-bottom-color: var(--blue); }
.project-overview p, .section-hint { color: var(--muted); font-size: 12px; line-height: 1.7; max-width: 800px; }
.project-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; margin: 20px 0; }
.project-metrics dt { color: var(--muted); font-size: 11px; }
.project-metrics dd { font-size: 22px; font-weight: 650; margin: 8px 0 0; }
.text-link { color: var(--blue); font-size: inherit; text-decoration: underline; }
@media (max-width: 800px) { .project-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.project-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 20px; }
button:focus-visible, select:focus-visible, input:focus-visible, summary:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
</style>
