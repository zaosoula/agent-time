import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeSettingsRoute } from '../src/ui/settings-navigation.ts';

test('old connections open the matching retained connection view', () => {
  assert.deepEqual(normalizeSettingsRoute('agents'), { section: 'connections', connection: 'agents' });
  assert.deepEqual(normalizeSettingsRoute('sources'), { section: 'connections', connection: 'sources' });
  assert.deepEqual(normalizeSettingsRoute('advanced'), { section: 'connections', connection: 'health' });
});

test('old policy destinations remain actionable in Projects', () => {
  assert.deepEqual(normalizeSettingsRoute('projects'), { section: 'connections', connection: 'linear', projectSection: 'attribution' });
  assert.deepEqual(normalizeSettingsRoute('billing'), { section: 'general', projectSection: 'billing' });
});

test('new sections round trip and unknown saved destinations recover to General', () => {
  for (const section of ['general', 'counting', 'connections', 'privacy', 'data']) {
    assert.equal(normalizeSettingsRoute(section).section, section);
  }
  assert.deepEqual(normalizeSettingsRoute('removed'), { section: 'general' });
  assert.deepEqual(normalizeSettingsRoute(null), { section: 'general' });
});

import { readFileSync } from 'node:fs';
import { computed, effectScope, nextTick, ref, watch } from 'vue';
import ts from 'typescript';

function settings(saved: string | null = null, target = 'general', explicit = false) {
  const source = readFileSync(new URL('../src/ui/CaptureSettings.vue', import.meta.url), 'utf8')
    .match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1]!.replace(/^import[\s\S]*?;\n/gm, '');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const scope = effectScope(), mounted: Array<() => void> = [], projects: unknown[][] = [];
  const savedValues = new Map(saved ? [['agent-time.settings-tab', saved]] : []);
  const store = { settingsSection: ref(target), settingsNavigationRequest: ref(explicit ? 1 : 0), connectionsSection: ref('sources'), page: ref('settings'),
    openProject: (...args: unknown[]) => projects.push(args) };
  const bindings = { ref, computed, watch, normalizeSettingsRoute, useStore: () => store,
    defineProps: () => ({ status: null, busy: false }), defineEmits: () => () => {},
    onMounted: (fn: () => void) => mounted.push(fn), onUnmounted: () => {}, native: false,
    sessionStorage: { getItem: (key: string) => savedValues.get(key), setItem: (key: string, value: string) => savedValues.set(key, value) },
    Settings2: {}, Clock3: {}, Layers3: {}, Lock: {}, Database: {},
    window: { addEventListener() {}, removeEventListener() {} } };
  const state = scope.run(() => new Function(...Object.keys(bindings), js + ';return {active,connection,visitedTabs,visitedConnections};')(...Object.values(bindings)));
  return { state, store, mounted, projects, savedValues, stop: () => scope.stop() };
}

test('nested connections are lazy and both visited views and settings sections remain retained', async () => {
  const p = settings();
  try {
    assert.deepEqual([...p.state.visitedTabs.value], ['general']);
    assert.equal(p.state.visitedConnections.value.size, 0);
    p.state.active.value = 'connections'; await nextTick();
    assert.deepEqual([...p.state.visitedConnections.value], ['sources']);
    p.state.connection.value = 'agents'; await nextTick();
    p.state.active.value = 'privacy'; await nextTick();
    assert.deepEqual([...p.state.visitedConnections.value], ['sources', 'agents']);
    assert.deepEqual([...p.state.visitedTabs.value], ['general', 'connections', 'privacy']);
    assert.equal(p.state.visitedConnections.value.has('health'), false);
    assert.equal(p.state.visitedTabs.value.has('data'), false);
    p.store.settingsSection.value = 'connections'; p.store.connectionsSection.value = 'health'; await nextTick();
    assert.equal(p.state.connection.value, 'health');
    assert.equal(p.state.visitedConnections.value.has('health'), true);
    assert.equal(p.savedValues.get('agent-time.settings-tab'), 'connections');
  } finally { p.stop(); }
});

test('explicit settings navigation wins over saved sections and old policies redirect on mount', () => {
  const direct = settings('data', 'connections');
  try { assert.equal(direct.state.active.value, 'connections'); assert.equal(direct.state.visitedTabs.value.has('data'), false); }
  finally { direct.stop(); }
  for (const [saved, destination] of [['projects', 'attribution'], ['billing', 'billing']]) {
    const p = settings(saved);
    try {
      for (const mount of p.mounted) mount();
      assert.deepEqual(p.projects, [[undefined, destination]]);
    } finally { p.stop(); }
  }
});

test('retained capture health refreshes recovery only while visible and active', async () => {
  const source = readFileSync(new URL('../src/ui/CaptureHealth.vue', import.meta.url), 'utf8')
    .match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1]!.replace(/^import[\s\S]*?;\n/gm, '');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const scope = effectScope(), mounted: Array<() => void> = [];
  const shown = ref(true), active = ref(false);
  let requests = 0, poll: (() => void) | undefined;
  const store = { captureHealth: ref(null), now: ref(0), page: ref('settings'), settingsSection: ref('connections'), connectionsSection: ref('health') };
  const bindings = { computed, ref, watch, onMounted: (fn: () => void) => mounted.push(fn), onUnmounted() {},
    defineProps: () => ({ status: null, issues: [], get active() { return active.value; } }), defineEmits: () => () => {},
    useStore: () => store, windowVisible: shown, preciseClock: String, humanizeError: String,
    setInterval: (fn: () => void) => { poll = fn; return 1; },
    transport: { diagnostics: async () => { requests++; return { recovery: [] }; } } };
  try {
    scope.run(() => new Function(...Object.keys(bindings), js)(...Object.values(bindings)));
    for (const mount of mounted) mount();
    assert.equal(requests, 0);
    active.value = true; await nextTick(); assert.equal(requests, 1);
    poll!(); assert.equal(requests, 2);
    active.value = false; await nextTick(); poll!(); assert.equal(requests, 2);
    active.value = true; shown.value = false; await nextTick(); poll!(); assert.equal(requests, 2);
    shown.value = true; await nextTick(); assert.equal(requests, 3);
  } finally { scope.stop(); }
});

test('explicit General opens General even on the first visit with another saved section',()=>{
 const p=settings('data','general',true);try{assert.equal(p.state.active.value,'general');assert.equal(p.state.visitedTabs.value.has('data'),false);}finally{p.stop();}
});
