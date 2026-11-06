<script setup lang="ts">
import { computed, ref } from 'vue';
import { Flag, Timer } from '@lucide/vue';
import type { ReportedWorkItem } from '../capture/reported-work.ts';
import type { TimeRange } from './timeline-viewport.ts';
import { clock, duration as elapsed } from './format.ts';

/** `compact` renders inside a project row: no heading, every item shown. */
const props = defineProps<{ items: ReportedWorkItem[]; range: TimeRange; now: number; compact?: boolean }>();
const expanded = ref(false);
const visible = computed(() =>
  props.items.filter((item) =>
    item.kind === 'context'
      ? item.start >= props.range.start && item.start <= props.range.end
      : item.end >= props.range.start && item.start <= props.range.end,
  ),
);
const shown = computed(() => (expanded.value || props.compact ? visible.value : visible.value.slice(0, 6)));
function placement(item: ReportedWorkItem) {
  const span = props.range.end - props.range.start;
  const from = Math.max(item.start, props.range.start),
    to = Math.min(item.end, props.range.end);
  return {
    left: `${Math.max(0, ((from - props.range.start) / span) * 100)}%`,
    width: item.kind === 'context' ? '3px' : `${Math.max(0.3, ((to - from) / span) * 100)}%`,
  };
}
</script>
<template>
  <section
    v-if="visible.length"
    class="reported-work"
    :class="{ compact }"
    :aria-label="compact ? 'Agent reported work for this project' : 'Agent reported work on timeline'"
  >
    <div v-if="!compact" class="reported-heading">
      <strong>Agent reported work</strong
      ><small>Task context and elapsed counters with no project on this day</small>
    </div>
    <div v-for="item in shown" :key="item.id" class="reported-row">
      <div class="reported-label">
        <Timer v-if="item.kind === 'counter'" :size="14" /><Flag v-else :size="14" /><span
          ><strong :title="item.title">{{ item.title }}</strong
          ><small
            >{{ item.issueKey ? item.issueKey + ' · ' : '' }}{{ item.provider || 'Agent'
            }}{{ item.sessionId ? ' · session ' + item.sessionId.slice(-6) : '' }}</small
          ></span
        >
      </div>
      <div class="reported-track">
        <span
          class="reported-mark"
          :class="item.kind"
          :style="placement(item)"
          :title="
            item.kind === 'context'
              ? `${clock(item.start)} · reported context`
              : `${clock(item.start)}–${clock(item.end)} · reported counter`
          "
        ></span>
      </div>
      <span class="reported-value"
        >{{
          item.kind === 'context' ? clock(item.start) : elapsed((item.active ? now : item.end) - item.start)
        }}<small v-if="item.active">open counter</small></span
      >
    </div>
    <button v-if="!compact && visible.length > 6" class="reported-more" @click="expanded = !expanded">
      {{ expanded ? 'Show fewer' : `Show ${visible.length - 6} more reported items` }}
    </button>
  </section>
</template>
<style scoped>
.reported-work {
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}
.reported-work.compact {
  background: transparent;
  border-bottom: 0;
}
.reported-work.compact .reported-row {
  min-height: 34px;
  padding-left: 41px;
  border-bottom: 1px dashed var(--border);
}
.reported-heading {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 15px;
  border-bottom: 1px solid var(--border);
}
.reported-heading strong {
  font-size: 11px;
}
.reported-heading small {
  font-size: var(--text-xs);
  color: var(--muted);
}
.reported-row {
  display: grid;
  grid-template-columns: 240px minmax(80px, 1fr) 98px;
  align-items: center;
  gap: 0;
  min-height: 42px;
  padding: 0 15px;
  border-bottom: 1px solid var(--border);
}
.reported-label {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  color: var(--blue);
}
.reported-label span {
  min-width: 0;
}
.reported-label strong,
.reported-label small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.reported-label strong {
  font-size: 11px;
  color: var(--text);
}
.reported-label small {
  font-size: var(--text-xs);
  color: var(--muted);
  margin-top: 2px;
}
.reported-track {
  position: relative;
  height: 22px;
  border-bottom: 1px dashed var(--border);
}
.reported-mark {
  position: absolute;
  top: 6px;
  height: 9px;
  background: var(--blue);
  border-radius: 4px;
  min-width: 3px;
}
.reported-mark.context {
  height: 14px;
  top: 3px;
  border-radius: 2px;
  background: var(--status-good);
}
.reported-value {
  text-align: right;
  font-size: var(--text-xs);
  font-variant-numeric: tabular-nums;
  color: var(--text);
}
.reported-value small {
  display: block;
  font-size: var(--text-xs);
  color: var(--muted);
}
.reported-more {
  display: block;
  padding: 8px 15px;
  color: var(--blue);
  font-size: var(--text-xs);
}
@media (max-width: 1120px) {
  .reported-row {
    grid-template-columns: 190px minmax(80px, 1fr) 82px;
  }
}
</style>
