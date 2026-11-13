import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { computed, effectScope, nextTick, reactive, ref, watch } from 'vue';
import ts from 'typescript';
import * as review from '../src/ui/review-apps.ts';
import { humanReviewState } from '../src/capture/human-review.ts';
import type { Interval } from '../src/capture/events.ts';

const interval = (key: string, start: number, extra: Partial<Interval> = {}): Interval => ({
  start, end: start + 10, state: 'human', proof: 'observed', sourceEventIds: [key + '-a', key + '-b'],
  foregroundBundleId: 'browser', foregroundName: 'Browser', browserTitle: 'Page', browserUrl: 'https://example.com/page', ...extra,
});
function editor(input: Interval[]) {
  const source = readFileSync(new URL('../src/ui/HumanReview.vue', import.meta.url), 'utf8')
    .match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1]!.replace(/^import[\s\S]*?;\n/gm, '');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const writes: unknown[][] = [], scopes = effectScope();
  const groups = review.buildAppReviewGroups(input);
  const store = reactive({ selectedDate: '2026-11-13', dayIntervals: input, appReviewGroups: groups,
    websiteProjects: { projects: ['/project'], matches: [] }, notes: [], reviewSiteFilter: '', applyReviewedSummary() {} });
  const bindings = { ...review, computed, ref, watch, reactive, nextTick, humanReviewState,
    defineEmits: () => () => {}, useStore: () => store, windowVisible: ref(true),
    onMounted() {}, onUnmounted() {}, onActivated() {}, onDeactivated() {},
    sessionStorage: { getItem: () => JSON.stringify({ version: 2, viewMode: 'all' }), setItem() {} },
    transport: { setHumanDecision: async (...args: unknown[]) => { writes.push(args); return {}; } },
    reviewTransport: { history: async () => [] }, minuteCreditSeconds: () => 0,
    humanizeError: String, duration: String };
  const state = scopes.run(() => new Function(...Object.keys(bindings), js + ';return {beginContextAssignment,bulkAssign,bulkProject,bulkPicker,allContexts,selectedGroups,bulkGroups,pending,splitDraft,toggleOpen,isOpen};')(...Object.values(bindings)));
  return { state, writes, groups, stop: () => scopes.stop() };
}

test('Assign group replaces unrelated selection, includes hidden eligible visits, and writes only on confirmation', async () => {
  const p = editor([...Array.from({ length: 35 }, (_, index) => interval('visit' + index, index * 20)), interval('other', 1000, { browserTitle: 'Other', browserUrl: 'https://other.example' })]);
  try {
    const context = p.state.allContexts.value.find((item: review.ReviewContextGroup) => item.groups.length === 35);
    const outside = p.groups.find(group => group.label === 'Other')!;
    p.state.selectedGroups.value = { [review.reviewGroupId(outside)]: true };
    p.state.bulkProject.value = '/stale';
    let focused = 0, scrolled = 0;
    p.state.bulkPicker.value = { querySelector: () => ({ focus: () => focused++, scrollIntoView: () => scrolled++ }) };
    await p.state.beginContextAssignment(context);
    assert.equal(p.writes.length, 0);
    assert.equal(p.state.bulkGroups.value.length, 35);
    assert.equal(p.state.selectedGroups.value[review.reviewGroupId(outside)], undefined);
    assert.equal(p.state.bulkProject.value, '');
    assert.equal(focused, 1); assert.equal(scrolled, 1);
    await p.state.bulkAssign(); assert.equal(p.writes.length, 0);
    p.state.bulkProject.value = '/chosen'; await p.state.bulkAssign();
    assert.equal(p.writes.length, 1);
    assert.equal((p.writes[0]![0] as unknown[]).length, 35);
    assert.equal(p.writes[0]![1], 'assigned'); assert.equal(p.writes[0]![2], '/chosen');
  } finally { p.stop(); }
});

test('group assignment excludes split parts and cannot change a selection during an action', async () => {
  const p = editor([interval('whole', 0), interval('split', 30, { reviewSegment: 'before' })]);
  try {
    const split = p.state.allContexts.value.find((item: review.ReviewContextGroup) => item.groups[0]!.reviewSegment);
    await p.state.beginContextAssignment(split); assert.equal(p.state.bulkGroups.value.length, 0);
    const context = p.state.allContexts.value.find((item: review.ReviewContextGroup) => !item.groups[0]!.reviewSegment);
    p.state.pending.value = 'saving'; await p.state.beginContextAssignment(context);
    assert.equal(p.state.bulkGroups.value.length, 0); assert.equal(p.writes.length, 0);
  } finally { p.stop(); }
});

test('closing secondary visit controls preserves an open split draft', () => {
  const p = editor([interval('whole', 0)]);
  try {
    const group = p.groups[0]!;
    const draft = { key: review.reviewGroupId(group), start: 0, end: 10, at: 4, before: '/one', after: '/two' };
    p.state.splitDraft.value = draft;
    p.state.toggleOpen(group);
    assert.deepEqual(p.state.splitDraft.value, draft); assert.equal(p.state.isOpen(group), true);
    assert.equal(p.writes.length, 0);
  } finally { p.stop(); }
});
