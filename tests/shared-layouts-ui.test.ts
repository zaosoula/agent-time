import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { compileScript, parse } from '@vue/compiler-sfc';
import { createRenderer, h, ref, type Component } from 'vue';
import ts from 'typescript';

type Node = { type: string; text: string; children: Node[]; parent: Node | null; props: Record<string, any> };
const node = (type: string): Node => ({ type, text: '', children: [], parent: null, props: {} });
const renderer = createRenderer<Node, Node>({
  createElement: node, createText: (text) => ({ ...node('text'), text }), createComment: (text) => ({ ...node('comment'), text }),
  setText: (item, text) => { item.text = text; }, setElementText: (item, text) => { item.text = text; item.children = []; },
  parentNode: (item) => item.parent, nextSibling: (item) => item.parent?.children[item.parent.children.indexOf(item) + 1] || null,
  insert: (item, parent, anchor) => {
    if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1);
    item.parent = parent; const index = anchor ? parent.children.indexOf(anchor) : -1;
    if (index < 0) parent.children.push(item); else parent.children.splice(index, 0, item);
  },
  remove: (item) => { if (item.parent) item.parent.children.splice(item.parent.children.indexOf(item), 1); item.parent = null; },
  patchProp: (item, key, _old, value) => { item.props[key] = value; },
});
function component(name: string): Component {
  const source = readFileSync(new URL(`../src/ui/${name}.vue`, import.meta.url), 'utf8');
  const parsed = parse(source); assert.deepEqual(parsed.errors, []);
  const compiled = compileScript(parsed.descriptor, { id: name, inlineTemplate: true });
  const code = ts.transpileModule(compiled.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, any> = {};
  new Function('require', 'exports', code)(createRequire(import.meta.url), exports);
  return exports.default;
}
function all(root: Node): Node[] { return [root, ...root.children.flatMap(all)]; }

test('AppCard retains native form semantics, attributes, class, submit handler and slot content', () => {
  const Card = component('AppCard'); const root = node('root'); let submitted = 0;
  const app = renderer.createApp({ render: () => h(Card, { as: 'form', padding: 'regular', class: 'editor', 'aria-label': 'Billing policy', onSubmit: () => submitted++ }, () => h('input', { name: 'rate', value: '120' })) });
  app.mount(root); const form = root.children[0]!;
  assert.equal(form.type, 'form'); assert.equal(form.props['aria-label'], 'Billing policy');
  assert.match(form.props.class, /app-card/); assert.match(form.props.class, /editor/);
  assert.equal(all(form).find((item) => item.type === 'input')!.props.value, '120');
  form.props.onSubmit(); assert.equal(submitted, 1); app.unmount();
});

test('SectionHeading retains requested heading hierarchy and leading, action and trailing content', () => {
  const Heading = component('SectionHeading'); const root = node('root');
  const app = renderer.createApp({ render: () => h(Heading, { title: 'Projects', description: 'Repository activity', level: 1, size: 'page', class: 'day-heading' }, {
    leading: () => h('span', { 'aria-hidden': 'true' }, 'icon'),
    actions: () => h('button', { 'aria-label': 'Previous day' }, 'Previous'),
    default: () => h('nav', { 'aria-label': 'Project sections' }, 'Overview'),
  }) });
  app.mount(root); const nodes = all(root);
  assert.equal(root.children[0]!.type, 'header'); assert.match(root.children[0]!.props.class, /day-heading/);
  assert.equal(nodes.filter((item) => item.type === 'h1').length, 1); assert.equal(all(nodes.find((item) => item.type === 'h1')!).map((item) => item.text).join(''), 'Projects');
  assert.equal(all(nodes.find((item) => item.type === 'p')!).map((item) => item.text).join(''), 'Repository activity');
  assert.equal(nodes.find((item) => item.type === 'button')!.props['aria-label'], 'Previous day');
  assert.equal(nodes.find((item) => item.type === 'nav')!.props['aria-label'], 'Project sections'); app.unmount();
});

test('SectionHeading custom heading slot preserves the native limits target ref without duplicate headings', () => {
  const Heading = component('SectionHeading'); const root = node('root'); const target = ref<Node | null>(null);
  const app = renderer.createApp({ render: () => h(Heading, { as: 'div', size: 'compact' }, {
    heading: () => h('h2', { ref: target, tabindex: -1 }, 'Account limits'),
    actions: () => h('small', 'Shared across sessions'),
  }) });
  app.mount(root); assert.equal(root.children[0]!.type, 'div');
  assert.equal(all(root).filter((item) => /^h[1-6]$/.test(item.type)).length, 1);
  assert.equal(target.value!.text, 'Account limits'); assert.equal(target.value!.props.tabindex, -1); app.unmount();
});

test('billing explanation displays saved totals without recomputing or modifying the report', () => {
  const Explanation=component('BillingReportExplanation'),root=node('root');
  const totals={humanActiveSeconds:3600,agentWallSeconds:7200,agentRunningSeconds:18000,overlapMergedWallSeconds:9000,rawEligibleSeconds:8000,countingAdjustmentSeconds:120,eligibleSeconds:8120,roundingSeconds:40,billableSeconds:8160,excludedSeconds:600,unknownSeconds:300,crossProjectOverlapSeconds:90,agentOnlyWallSeconds:5400,aiKnownAmount:7.25};
  const report={totals,countingModes:['minutes'],currency:'EUR',explanation:'Saved evidence explanation',calculationVersion:'fixture-version'};
  const before=structuredClone(report);const app=renderer.createApp({render:()=>h(Explanation,{report})});app.mount(root);
  const items=all(root),steps=items.filter(item=>item.type==='li');
  assert.equal(steps.length,5);
  assert.deepEqual(steps.map(step=>all(step).find(item=>item.type==='strong')!.props.title),[8000,120,8120,40,8160].map(n=>`${n.toLocaleString(undefined,{maximumFractionDigits:3})} seconds`));
  const text=items.map(item=>item.text).join(' ');assert.match(text,/One started minute/);assert.match(text,/not additional deductions/);assert.match(text,/7.25 EUR/);assert.match(text,/Saved evidence explanation/);assert.match(text,/fixture-version/);
  assert.deepEqual(report,before);app.unmount();
});
