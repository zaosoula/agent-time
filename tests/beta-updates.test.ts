import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkBetaUpdate,
  installBetaUpdate,
  progressEvent,
  progressLabel,
  type BetaUpdateProgress,
  type UpdaterBridge,
} from '../src/ui/beta-updates.ts';

function fakeBridge(results: Record<string, () => Promise<unknown>>, emitted: BetaUpdateProgress[] = []) {
  const calls: string[] = [];
  const bridge: UpdaterBridge = {
    invoke: async <T>(command: string) => {
      calls.push(command);
      return (await results[command]!()) as T;
    },
    listen: async <T>(event: string, handler: (payload: T) => void) => {
      calls.push(`listen:${event}`);
      for (const item of emitted) handler(item as T);
      return () => calls.push(`unlisten:${event}`);
    },
  };
  return { bridge, calls };
}

test('checking asks the host for an available beta update', async () => {
  const update = { version: '0.2.0-beta.19', currentVersion: '0.2.0-beta.18', body: 'Fixes', date: 1_700_000_000 };
  const { bridge, calls } = fakeBridge({ beta_update_check: async () => update });
  assert.deepEqual(await checkBetaUpdate(bridge), update);
  assert.deepEqual(calls, ['beta_update_check']);
});

test('no update resolves to null', async () => {
  const { bridge } = fakeBridge({ beta_update_check: async () => null });
  assert.equal(await checkBetaUpdate(bridge), null);
});

test('install listens for progress, invokes the host install and stops listening', async () => {
  const seen: BetaUpdateProgress[] = [];
  const { bridge, calls } = fakeBridge({ beta_update_install: async () => undefined }, [
    { event: 'Progress', downloaded: 50, total: 100 },
    { event: 'Finished' },
  ]);
  await installBetaUpdate(bridge, (progress) => seen.push(progress));
  assert.deepEqual(calls, [`listen:${progressEvent}`, 'beta_update_install', `unlisten:${progressEvent}`]);
  assert.equal(seen.length, 2);
});

test('a failed install rejects with the host error and still stops listening', async () => {
  const { bridge, calls } = fakeBridge({
    beta_update_install: async () => {
      throw new Error('bad signature');
    },
  });
  await assert.rejects(installBetaUpdate(bridge), /bad signature/);
  assert.equal(calls.at(-1), `unlisten:${progressEvent}`);
});

test('progress labels report percentage when the size is known', () => {
  assert.equal(progressLabel(null), 'Preparing update…');
  assert.equal(progressLabel({ event: 'Progress', downloaded: 25, total: 100 }), 'Downloading… 25%');
  assert.equal(progressLabel({ event: 'Progress', downloaded: 25, total: null }), 'Downloading…');
  assert.equal(progressLabel({ event: 'Finished' }), 'Installing and restarting…');
});
