import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parse, compileScript, compileStyle } from '@vue/compiler-sfc';
import { createRenderer, h, nextTick, reactive } from 'vue';
import ts from 'typescript';

type Node = { type: string; props: Record<string, any>; children: Node[]; parent: Node | null; text: string };
const node = (type: string): Node => ({ type, props: {}, children: [], parent: null, text: '' });
const renderer = createRenderer<Node, Node>({
  createElement: node, createText: text => ({ ...node('text'), text }), createComment: node,
  setText: (item, text) => { item.text = text; }, setElementText: (item, text) => { item.text = text; },
  parentNode: item => item.parent, nextSibling: () => null,
  insert(item, parent) { item.parent = parent; parent.children.push(item); },
  remove(item) { if (item.parent) item.parent.children = item.parent.children.filter(child => child !== item); },
  patchProp(item, key, _before, value) { item.props[key] = value; },
});
function buttonComponent() {
  const file = new URL('../src/ui/AppButton.vue', import.meta.url);
  const { descriptor } = parse(readFileSync(file, 'utf8'), { filename: file.pathname });
  const compiled = compileScript(descriptor, { id: 'app-button-test', inlineTemplate: true });
  const js = ts.transpileModule(compiled.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, any> = {};
  new Function('require', 'exports', js)(createRequire(import.meta.url), exports);
  return exports.default;
}

test('shared button defaults to a native non-submit button and preserves attrs, click event and slot', () => {
  const AppButton = buttonComponent(), root = node('root'), events: unknown[] = [];
  const app = renderer.createApp({ render: () => h(AppButton, { id: 'save', 'aria-label': 'Save draft', class: 'custom', onClick: (event: unknown) => events.push(event) }, () => 'Save') });
  app.mount(root);
  try {
    const button = root.children.find(child => child.type === 'button')!;
    assert.equal(button.props.type, 'button');
    assert.equal(button.props.id, 'save'); assert.equal(button.props['aria-label'], 'Save draft');
    assert.match(button.props.class, /\bbtn\b/); assert.match(button.props.class, /\bcustom\b/);
    const event = { type: 'click' }; button.props.onClick(event); assert.deepEqual(events, [event]);
    assert(button.children.some(child => child.text === 'Save'));
  } finally { app.unmount(); }
});

test('shared button supports explicit submit, disabled state, compact sizing and semantic variants', async () => {
  const AppButton = buttonComponent(), root = node('root');
  const props = reactive({ type: 'submit', disabled: true, compact: true, variant: 'primary' });
  const app = renderer.createApp({ render: () => h(AppButton, props, () => 'Apply') }); app.mount(root);
  try {
    const button = root.children.find(child => child.type === 'button')!;
    assert.equal(button.props.type, 'submit'); assert.equal(button.props.disabled, true);
    assert.match(button.props.class, /\bbtn-primary\b/); assert.match(button.props.class, /\bbtn-sm\b/);
    props.variant = 'danger'; props.disabled = false; props.compact = false; await nextTick();
    assert.match(button.props.class, /\bbtn-danger\b/); assert.doesNotMatch(button.props.class, /\bbtn-sm\b/);
    assert.equal(button.props.disabled, false);
    props.variant = 'quiet'; await nextTick(); assert.match(button.props.class, /\bbtn-quiet\b/);
  } finally { app.unmount(); }
});


test('shared sizing preserves multiline buttons and excludes choice, range and multiline fields', () => {
  const source = ['design-tokens.css', 'style.css'].map(file => readFileSync(new URL(`../src/ui/${file}`, import.meta.url), 'utf8')).join('\n');
  const result = compileStyle({ source, filename: 'style.css', id: 'controls-test' });
  assert.deepEqual(result.errors, []);
  const rules = new Map<string, Map<string, string>>();
  result.rawResult!.root.walkRules(rule => {
    const declarations = rules.get(rule.selector) || new Map<string, string>();
    rule.walkDecls(item => { declarations.set(item.prop, item.value); });
    rules.set(rule.selector, declarations);
  });
  assert.equal(rules.get(':root')!.get('--control-height'), '36px');
  assert.equal(rules.get(':root')!.get('--control-height-compact'), '32px');
  const button = rules.get('.btn')!;
  assert.equal(button.get('min-height'), 'var(--control-height)');
  assert.equal(button.has('height'), false); assert.equal(button.has('max-height'), false);
  const fields = [...rules.keys()].find(selector => selector.includes("input[type='datetime-local']"))!;
  assert(fields.includes("input[type='date']")); assert(fields.includes("input[type='text']"));
  for (const excluded of ['checkbox', 'radio', 'range', 'hidden']) assert(!fields.includes(`input[type='${excluded}']`));
  assert(!fields.includes('textarea')); assert(fields.includes('select:not([multiple]):not([size])'));
  // No generic native button sizing is introduced: hierarchy and timeline buttons keep their geometry.
  assert.equal(rules.get('button')?.has('height'), false);
  assert.equal(rules.get('button')?.has('min-height'), false);
});
