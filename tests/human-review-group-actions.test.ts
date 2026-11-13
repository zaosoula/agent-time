import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { computed, effectScope, nextTick, reactive, ref, watch } from 'vue';
import ts from 'typescript';
import * as review from '../src/ui/review-apps.ts';
import * as reviewTree from '../src/ui/review-tree.ts';
import * as reviewWorkspace from '../src/ui/review-workspace.ts';
import { humanReviewState } from '../src/capture/human-review.ts';
import type { Interval } from '../src/capture/events.ts';

const interval = (key: string, start: number, extra: Partial<Interval> = {}): Interval => ({
  start, end: start + 10, state: 'human', proof: 'observed', sourceEventIds: [key + '-a', key + '-b'],
  foregroundBundleId: 'browser', foregroundName: 'Browser', browserTitle: 'Page', browserUrl: 'https://example.com/page', ...extra,
});
class ReviewElement {
  id: string;
  constructor(id: string) { this.id = id; }
  closest(selector: string) { return selector === '.review-tree-row' ? this : null; }
}
function editor(input: Interval[]) {
  const source = readFileSync(new URL('../src/ui/HumanReview.vue', import.meta.url), 'utf8')
    .match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1]!.replace(/^import[\s\S]*?;\n/gm, '');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const writes: unknown[][] = [], scopes = effectScope();
  const groups = review.buildAppReviewGroups(input);
  const store = reactive({ selectedDate: '2026-11-13', dayIntervals: input, appReviewGroups: groups,
    websiteProjects: { projects: ['/project'], matches: [] }, notes: [], reviewSiteFilter: '', reviewProjectFilter: 'all', page: 'review', applyReviewedSummary() {} });
  const bindings = { ...review, ...reviewTree, ...reviewWorkspace, Element: ReviewElement, document: { body: {}, getElementById: () => null }, computed, ref, watch, reactive, nextTick, humanReviewState,
    defineEmits: () => () => {}, useStore: () => store, windowVisible: ref(true),
    onMounted() {}, onUnmounted() {}, onActivated() {}, onDeactivated() {},
    sessionStorage: { getItem: () => JSON.stringify({ version: 2, viewMode: 'all' }), setItem() {} },
    transport: { setHumanDecision: async (...args: unknown[]) => { writes.push(args); return {}; } },
    reviewTransport: { history: async () => [] }, minuteCreditSeconds: () => 0,
    humanizeError: String, duration: String };
  const state = scopes.run(() => new Function(...Object.keys(bindings), js + ';return {assignNode,selectNode,tree,expandedTree,focused,keyboard,root,bulkAssign,bulkProject,selectedGroups,bulkGroups,pending,splitDraft,toggleOpen,isOpen};')(...Object.values(bindings)));
  return { state, writes, groups, stop: () => scopes.stop() };
}

const descendants = (nodes: reviewTree.ReviewNode[]): reviewTree.ReviewNode[] => nodes.flatMap(node => [node, ...descendants(node.children)]);

test('assigning a collapsed context includes all descendant visits despite unrelated selection', async () => {
  const p = editor([...Array.from({ length: 35 }, (_, index) => interval('visit' + index, index * 20)), interval('other', 1000, { browserTitle: 'Other', browserUrl: 'https://other.example' })]);
  try {
    const context = descendants(p.state.tree.value).find(node => node.kind === 'context' && node.groups.length === 35)!;
    const outside = p.groups.find(group => group.label === 'Other')!;
    p.state.selectedGroups.value = { [review.reviewGroupId(outside)]: true };
    assert.deepEqual(p.state.expandedTree.value, {});
    assert.equal(p.writes.length, 0);
    await p.state.assignNode(context, '/chosen');
    assert.equal(p.writes.length, 1);
    assert.deepEqual(p.writes[0]![0], context.groups.flatMap(group => group.pairs));
    assert.equal(p.writes[0]![1], 'assigned');
    assert.equal(p.writes[0]![2], '/chosen');
    assert.equal(p.writes[0]![3], '2026-11-13');
    assert.deepEqual(p.state.selectedGroups.value, {});
  } finally { p.stop(); }
});

test('a selected descendant makes a row assignment apply to the full global selection', async () => {
  const p = editor([interval('one', 0), interval('two', 30), interval('other', 60, { browserUrl: 'https://other.example', browserTitle: 'Other' })]);
  try {
    const context = descendants(p.state.tree.value).find(node => node.kind === 'context' && node.groups.length === 2)!;
    const outside = p.groups.find(group => group.label === 'Other')!;
    const selected = [context.groups[0]!, outside];
    p.state.selectedGroups.value = Object.fromEntries(selected.map(group => [review.reviewGroupId(group), true]));
    await p.state.assignNode(context, null);
    assert.equal(p.writes.length, 1);
    assert.deepEqual(p.writes[0]![0], selected.flatMap(group => group.pairs));
    assert.equal(p.writes[0]![1], 'unassigned');
    assert.equal(p.writes[0]![2], undefined);
  } finally { p.stop(); }
});

test('tree assignments include split parts and pending actions prevent selection or assignment changes', async () => {
  const p = editor([interval('whole', 0), interval('split', 30, { reviewSegment: 'before' })]);
  try {
    const app = p.state.tree.value[0] as reviewTree.ReviewNode;
    p.state.pending.value = 'saving';
    p.state.selectNode(app, true);
    await p.state.assignNode(app, '/chosen');
    assert.equal(p.state.bulkGroups.value.length, 0);
    assert.equal(p.writes.length, 0);
    p.state.pending.value = '';
    p.state.selectNode(app, true);
    assert.equal(p.state.bulkGroups.value.length, 2);
    await p.state.assignNode(app, '/chosen');
    const whole = p.groups.find(group => !group.reviewSegment)!;
    const split = p.groups.find(group => group.reviewSegment)!;
    assert.equal(p.writes.length, 1);
    assert.deepEqual(p.writes[0]![0], whole.pairs);
    assert.deepEqual(p.writes[0]![4], split.pairs.map(pair => ({ pair, segment: 'before' })));
  } finally { p.stop(); }
});

test('U unassigns the event focused DOM row rather than the cached row', async () => {
  const p = editor([interval('browser', 0), interval('native', 30, { foregroundBundleId: 'editor', foregroundName: 'Editor', browserUrl: undefined, browserTitle: undefined })]);
  try {
    const root = p.state.tree.value[0] as reviewTree.ReviewNode;
    p.state.expandedTree.value[root.key]=true;
    const rows = root.children;
    assert.equal(rows.length, 2);
    const cached = rows[0]!, actual = rows[1]!;
    p.state.focused.value = cached.key;
    const target = new ReviewElement(`review-tree-${actual.key}`);
    p.state.root.value = { contains: (element: unknown) => element === target };
    let prevented = false;
    p.state.keyboard({ key: 'u', target, preventDefault() { prevented = true; } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(prevented, true);
    assert.equal(p.state.focused.value, actual.key);
    assert.equal(p.writes.length, 1);
    assert.deepEqual(p.writes[0]![0], actual.groups.flatMap(group => group.pairs));
    assert.equal(p.writes[0]![1], 'unassigned');
    assert.notDeepEqual(p.writes[0]![0], cached.groups.flatMap(group => group.pairs));
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
