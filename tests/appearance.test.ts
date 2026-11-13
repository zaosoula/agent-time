import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appearance, startAppearance } from '../src/ui/appearance.ts';

test('appearance follows the Mac only in system mode, persists explicit choices and releases listeners', () => {
  const values = new Map<string, string>([['agent-time.appearance', 'system']]);
  const classes = new Set<string>();
  const listeners = new Map<string, (...args: any[]) => void>();
  const media = { matches: true, addEventListener: (name: string, fn: () => void) => listeners.set(name, fn), removeEventListener: (name: string) => listeners.delete(name) };
  const style = { colorScheme: '' };
  const environment = {
    matchMedia: () => media,
    localStorage: { getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value) },
    document: { documentElement: { classList: { toggle: (name: string, enabled: boolean) => enabled ? classes.add(name) : classes.delete(name) }, style } },
    addEventListener: (name: string, fn: (...args: any[]) => void) => listeners.set(name, fn),
    removeEventListener: (name: string) => listeners.delete(name),
  } as unknown as Window;
  const stop = startAppearance(environment);
  assert.equal(classes.has('ui-dark'), true);
  appearance.value = 'light';
  assert.equal(style.colorScheme, 'light');
  assert.equal(values.get('agent-time.appearance'), 'light');
  listeners.get('change')!();
  assert.equal(classes.has('ui-dark'), false);
  appearance.value = 'system';
  assert.equal(classes.has('ui-dark'), true);
  media.matches = false;
  listeners.get('change')!();
  assert.equal(style.colorScheme, 'light');
  listeners.get('storage')!({ key: 'agent-time.appearance', newValue: 'dark' });
  assert.equal(classes.has('ui-dark'), true);
  stop();
  assert.equal(listeners.size, 0);
});

test('denied preference storage still allows appearance selection', () => {
  const style = { colorScheme: '' };
  const stop = startAppearance({
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    localStorage: { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } },
    document: { documentElement: { classList: { toggle() {} }, style } },
    addEventListener() {}, removeEventListener() {},
  } as unknown as Window);
  appearance.value = 'dark';
  assert.equal(style.colorScheme, 'dark');
  stop();
});
