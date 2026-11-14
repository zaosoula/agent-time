<script setup lang="ts">
import { computed, ref, onMounted, onActivated, nextTick, watch } from 'vue';
import type { CaptureStatus } from './transport.ts';
import { usePagePresentation } from './page-presentation.ts';
import AppCard from './AppCard.vue';
import SectionHeading from './SectionHeading.vue';
import { useStore } from './store.ts';
import { compactNumber, count, dateTime, usd, shiftDate } from './format.ts';
const props = defineProps<{ status: CaptureStatus | null }>();
const store = useStore();
const limitsSection=ref<HTMLElement|null>(null);
const presented = usePagePresentation();
const active = computed(() => presented.value && store.page.value === 'reports' && store.reportsSection.value === 'usage');
async function focusLimits() {
  if (!active.value || store.usageFocus.value !== 'limits') return;
  // Workspace and report scroll restoration each run after the first render.
  // Apply an explicit destination only after those restorations have finished.
  await nextTick();
  await nextTick();
  if (!active.value || store.usageFocus.value !== 'limits' || !limitsSection.value) return;
  limitsSection.value.scrollIntoView({ block: 'start' });
  limitsSection.value.focus({ preventScroll: true });
  store.usageFocus.value = '';
}
onActivated(() => { void focusLimits(); });
watch([() => store.usageFocus.value, () => store.usage.value, active], () => { void focusLimits(); });
const usage = store.usage,
  error = store.usageError,
  provider = ref('all');
/** Recomputed when usage refreshes; date boundaries only need minute precision. */
const now = computed(() => (store.minute.value || Date.now() / 1000) * 1000);
const agents = computed(() => props.status?.sources.filter((source) => source.kind === 'agent') || []);
const scanningEnabled = computed(() =>
  Boolean(
    props.status?.surfaces.tokenUsage &&
    agents.value.some((source) => props.status?.surfaces[source.usageSetting || '']),
  ),
);
const providerName = (id: string) => agents.value.find((source) => source.id === id)?.name || id;
const key = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = computed(() => key(new Date(now.value))),
  month = computed(() => today.value.slice(0, 7));
const week = computed(() => {
  const monday = new Date(now.value);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return key(monday);
});
const number = compactNumber;
const money = usd;
const rows = computed(
  () => usage.value?.days.filter((d) => provider.value === 'all' || d.provider === provider.value) || [],
);
const total = (start: string, end?: string) =>
  rows.value
    .filter((d) => d.date >= start && (!end || d.date <= end))
    .reduce(
      (a, d) => ({ tokens: a.tokens + d.tokens, usd: a.usd + d.usd, unpriced: a.unpriced + d.unpriced }),
      { tokens: 0, usd: 0, unpriced: 0 },
    );
const periods = computed(() => [{title:'Selected period',...total(store.period.value.from,store.period.value.to)}]);
const days = computed(() => {
 const result=[];
 for(let date=store.period.value.from;date<=store.period.value.to;date=shiftDate(date,1)){
  const entries=rows.value.filter(d=>d.date===date);
  result.push({date,day:Number(date.slice(-2)),tokens:entries.reduce((a,d)=>a+d.tokens,0),usd:entries.reduce((a,d)=>a+d.usd,0)});
 }
 return result;
});
const peak = computed(() => Math.max(1, ...days.value.map((d) => d.tokens)));
const breakdown = computed(() =>
  rows.value
    .filter((d) => d.date >= store.period.value.from && d.date <= store.period.value.to)
    .reduce(
      (a, d) => ({
        input: a.input + d.counts.input,
        output: a.output + d.counts.output,
        read: a.read + d.counts.cacheRead,
        write: a.write + d.counts.cacheWrite,
        reasoning: a.reasoning + d.counts.reasoning,
      }),
      { input: 0, output: 0, read: 0, write: 0, reasoning: 0 },
    ),
);
const models = computed(
  () =>
    usage.value?.models.filter(
      (m) => m.tokens > 0 && (provider.value === 'all' || m.provider === provider.value),
    ) || [],
);
const limits = computed(
  () => usage.value?.limits.filter((l) => provider.value === 'all' || l.provider === provider.value) || [],
);
/** Millisecond timestamps from the usage reader. */
const time = (n: number | null) => (n ? dateTime(n / 1000) : 'Unknown');
onMounted(() => {
  if (!usage.value) void store.refreshUsage();
});
</script>
<template>
  <section class="usage-page">
    <SectionHeading as="div" class="usage-heading" title="Usage" description="Token totals follow the selected period. Provider account limits remain live and account-wide." size="page">
      <template #actions>
      <select v-model="provider" aria-label="Filter usage provider">
        <option value="all">All providers</option>
        <option v-for="agent in agents" :key="agent.id" :value="agent.id">{{ agent.name }}</option>
      </select>
      </template>
    </SectionHeading>
    <p v-if="!scanningEnabled" class="usage-notice">
      Token scanning is disabled. Enable token usage in Settings → Capture &amp; connections → Agents to update this history.
    </p>
    <p v-if="error || usage?.error" class="usage-notice">{{ error || usage?.error }}</p>
    <div v-if="!usage" class="usage-loading" aria-busy="true">
      <span class="visually-hidden" role="status">Loading usage…</span>
      <div class="usage-metrics">
        <AppCard as="article" padding="regular" class="usage-metric" v-for="index in 3" :key="index">
          <span class="skeleton skeleton-label"></span>
          <span class="skeleton skeleton-value"></span>
        </AppCard>
      </div>
      <span class="skeleton skeleton-chart"></span>
    </div>
    <template v-else>
      <div class="usage-metrics">
        <AppCard as="article" padding="regular" class="usage-metric" v-for="period in periods" :key="period.title">
          <small>{{ period.title }} tokens</small><strong>{{ number(period.tokens) }}</strong
          ><span
            >{{ money(period.usd) }}
            <small>API equivalent{{ period.unpriced ? ' · priced portion' : '' }}</small></span
          >
        </AppCard>
      </div>
      <AppCard class="usage-panel">
        <SectionHeading as="div" class="usage-panel-title" title="Daily usage in selected period" size="compact">
          <template #actions><small>{{
            usage?.scanning
              ? `Reading history · ${usage.filesScanned} files checked`
              : `Updated ${usage?.lastScan ? time(usage.lastScan * 1000) : 'not yet'}`
          }}</small></template>
        </SectionHeading>
        <div class="usage-chart">
          <div
            v-for="d in days"
            :key="d.date"
            class="usage-chart-column"
            :title="`${d.date}: ${count(d.tokens)} tokens · ${money(d.usd)} API equivalent`"
          >
            <div
              :class="['usage-chart-bar', { today: d.date === today }]"
              :style="{ height: d.tokens ? `${Math.max(2, (d.tokens / peak) * 100)}%` : '0%' }"
            ></div>
            <small v-if="d.day === 1 || d.day % 5 === 0 || d.date === today">{{ d.day }}</small>
          </div>
        </div>
        <div class="usage-breakdown">
          <span>Selected period breakdown</span>
          <dl>
            <div>
              <dt>Input</dt>
              <dd>{{ number(breakdown.input) }}</dd>
            </div>
            <div>
              <dt>Output</dt>
              <dd>{{ number(breakdown.output) }}</dd>
            </div>
            <div>
              <dt>Cache write</dt>
              <dd>{{ number(breakdown.write) }}</dd>
            </div>
            <div>
              <dt>Cache read</dt>
              <dd>{{ number(breakdown.read) }}</dd>
            </div>
          </dl>
          <small>Reasoning: {{ number(breakdown.reasoning) }} · already included in output</small>
        </div>
      </AppCard>
      <AppCard class="usage-panel">
        <SectionHeading as="div" class="usage-panel-title" size="compact">
          <template #heading><h2 ref="limitsSection" tabindex="-1">Account limits</h2></template>
          <template #actions><small>Shared across all sessions · reported by Orca</small></template>
        </SectionHeading>
        <article
          v-for="(limit, index) in limits"
          :key="limit.provider + limit.accountId"
          class="limit-account"
        >
          <div class="limit-heading">
            <strong
              >{{ providerName(limit.provider) }} ·
              {{ limit.accountId === 'default' ? 'Default account' : `Account ${index + 1}` }}</strong
            ><small
              >{{ limit.status }} · updated {{ time(limit.updatedAt)
              }}{{ limit.updatedAt && Date.now() - limit.updatedAt > 900000 ? ' · stale' : '' }}</small
            >
          </div>
          <div
            v-for="[name, window] in [
              ['Session', limit.session],
              ['Weekly', limit.weekly],
            ]"
            :key="name"
            class="limit-window"
          >
            <span>{{ name }}</span
            ><template v-if="window"
              ><div class="limit-track"><i :style="{ width: window.usedPercent + '%' }"></i></div>
              <strong>{{ Math.round(100 - window.usedPercent) }}% remaining</strong
              ><small>Resets {{ time(window.resetsAt) }}</small></template
            ><small v-else>Not reported</small>
          </div>
        </article>
        <p v-if="!limits.length" class="usage-empty">No account limits have been received yet.</p>
      </AppCard>
      <AppCard class="usage-panel">
        <SectionHeading as="div" class="usage-panel-title" title="Models in available history" size="compact" />
        <table>
          <thead>
            <tr>
              <th>Model</th>
              <th>Tokens</th>
              <th>API equivalent</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in models" :key="m.provider + m.model">
              <td>{{ m.model }}</td>
              <td>{{ number(m.tokens) }}</td>
              <td>{{ m.unpriced ? 'Unavailable' : money(m.usd) }}</td>
            </tr>
            <tr v-if="!models.length">
              <td colspan="3" class="usage-empty">No model usage captured this month.</td>
            </tr>
          </tbody>
        </table>
      </AppCard>
      <p v-if="usage?.pricing.error" class="usage-notice">
        Pricing update failed: {{ usage.pricing.error }}. Keeping the last valid rates.
      </p>
      <p class="usage-footnote">
        API equivalent is a standard, short-context, global pricing estimate in USD, not a subscription bill.
        Long context, speed tiers, region, and tool fees can differ. Unknown models remain unpriced. New usage
        uses rates verified {{ usage?.pricingCheckedAt
        }}{{ usage?.pricing.stale ? ' · verification overdue' : '' }}. Earlier estimates retain their imported
        pricing version.
        {{
          usage?.pricing.configured
            ? 'Updates checked daily while capture is enabled.'
            : 'Using bundled rates; update URL not configured.'
        }}
        ·
        <a
          v-for="(source, index) in usage?.pricingSources"
          :key="source"
          :href="source"
          target="_blank"
          rel="noreferrer"
          >{{ index === 0 ? 'OpenAI' : 'Anthropic' }}
        </a>
      </p>
    </template>
  </section>
</template>
<style scoped>
.skeleton-label {
  width: 40%;
  height: 11px;
}
.skeleton-value {
  width: 60%;
  height: 24px;
  margin-top: 8px;
}
.skeleton-chart {
  height: 180px;
  margin-top: 18px;
}
.usage-page {
  padding: 30px 32px;
  overflow: auto;
  flex: 1;
}
.usage-heading { margin-bottom: 24px; }
select {
  border: 1px solid var(--border);
  border-radius: var(--control-radius, 6px);
  min-height: var(--control-height, 32px);
  box-sizing: border-box;
  padding: var(--control-padding-block, 7px) var(--control-padding-inline, 10px);
  font-size: var(--control-font-size, 12px);
  line-height: var(--control-line-height, 16px);
  color: var(--text);
  background: var(--panel);
}
.usage-metrics {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  margin-bottom: 22px;
}
.usage-metric { display: flex; flex-direction: column; gap: 8px; }
.usage-metrics strong {
  font-size: 32px;
  letter-spacing: -1px;
}
.usage-metrics small,
.usage-panel small {
  color: var(--muted);
  font-size: 11px;
}
.usage-panel {
  margin-bottom: 20px;
  overflow: hidden;
}
.usage-panel-title {
  padding: 18px 20px;
}
.usage-panel-title h2 {
  font-size: 13px;
  margin: 0;
}
.usage-chart {
  height: 150px;
  display: flex;
  gap: 4px;
  padding: 5px 20px 25px;
  margin-bottom: 12px;
}
.usage-chart-column {
  flex: 1;
  height: 100%;
  display: flex;
  justify-content: flex-end;
  flex-direction: column;
  position: relative;
}
.usage-chart-bar {
  background: #808895;
  border-radius: 3px 3px 0 0;
  min-height: 0;
}
.usage-chart-bar.today {
  background: var(--blue);
}
.usage-chart-column small {
  position: absolute;
  bottom: -22px;
  width: 100%;
  text-align: center;
  font-size: var(--text-xs);
}
.usage-breakdown {
  border-top: 1px solid var(--border);
  padding: 16px 20px;
}
.usage-breakdown > span {
  font-size: 12px;
  font-weight: 600;
}
.usage-breakdown dl {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  margin: 12px 0;
  gap: 14px;
}
.usage-breakdown dt {
  font-size: var(--text-xs);
  color: var(--muted);
}
.usage-breakdown dd {
  margin: 5px 0;
  font-size: 16px;
  font-weight: 600;
}
.limit-account {
  padding: 16px 20px;
  border-top: 1px solid var(--border);
}
.limit-heading {
  display: flex;
  justify-content: space-between;
  margin-bottom: 14px;
}
.limit-window {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 10px 0;
  font-size: 11px;
}
.limit-window > span {
  width: 52px;
}
.limit-window strong {
  font-size: 11px;
  font-weight: 500;
  min-width: 95px;
}
.limit-track {
  height: 5px;
  width: 150px;
  background: var(--border);
  border-radius: 5px;
  overflow: hidden;
}
.limit-track i {
  display: block;
  height: 100%;
  background: var(--blue);
}
table {
  width: 100%;
  border-collapse: collapse;
}
th,
td {
  padding: 12px 20px;
  text-align: left;
  border-top: 1px solid var(--border);
  font-size: 11px;
}
th {
  color: var(--muted);
  font-weight: 500;
}
.usage-footnote,
.usage-empty {
  color: var(--muted);
  font-size: 11px;
  line-height: 1.6;
}
.usage-empty {
  padding: 0 20px 16px;
}
.usage-footnote a {
  color: var(--blue);
}
.usage-notice {
  padding: 12px;
  background: var(--hover);
  font-size: 12px;
  border-radius: 7px;
}
.usage-chart-column small {
  font-size: var(--text-xs);
}
.usage-empty {
  color: var(--muted);
  font-size: 12px;
}
.usage-panel td.usage-empty {
  text-align: center;
  padding: 20px;
}
.usage-page select:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: 2px;
}
@media (max-width: 1150px) {
  .usage-metrics {
    gap: 10px;
  }
  .usage-metrics article {
    padding: 15px;
  }
  .usage-metrics strong {
    font-size: 26px;
  }
  .limit-window {
    flex-wrap: wrap;
  }
  .limit-track {
    flex: 1;
    min-width: 100px;
  }
}
@media (max-width: 800px) {
  .usage-page {
    padding: 20px;
  }
  .usage-heading {
    align-items: flex-start;
    gap: 12px;
    flex-wrap: wrap;
  }
  .usage-metrics {
    grid-template-columns: 1fr;
  }
  .usage-metrics article {
    gap: 3px;
  }
  .usage-breakdown dl {
    grid-template-columns: repeat(2, 1fr);
  }
  .usage-panel-title,
  .limit-heading {
    align-items: flex-start;
    gap: 8px;
    flex-wrap: wrap;
  }
}
</style>
