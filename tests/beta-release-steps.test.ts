import assert from 'node:assert/strict';
import test from 'node:test';
import {betaBundleEnvironment, notarizeBetaDmg, validateStaple} from '../scripts/beta-release-steps.mjs';

const credentials = {
  APPLE_API_KEY: 'key-id',
  APPLE_API_ISSUER: 'issuer-id',
  APPLE_API_KEY_PATH: '/protected/notary.p8',
};

test('beta packaging skips Finder automation even when the caller is interactive', () => {
  assert.equal(betaBundleEnvironment({CI: 'false'}).CI, 'true');
});

test('a DMG is stapled only after Apple accepts its notarization', () => {
  const calls: string[][] = [];
  const accepted = (_command: string, args: string[]) => {
    calls.push(args);
    return args[0] === 'notarytool' ? JSON.stringify({status: 'Accepted'}) : '';
  };
  notarizeBetaDmg('/release/Agent Time.dmg', credentials, accepted);
  assert.deepEqual(calls.map(args => args.slice(0, 2)), [
    ['notarytool', 'submit'],
    ['stapler', 'staple'],
  ]);
  assert.ok(calls[0].includes('/protected/notary.p8'));

  calls.length = 0;
  const rejected = (_command: string, args: string[]) => {
    calls.push(args);
    return JSON.stringify({status: 'Invalid'});
  };
  assert.throws(() => notarizeBetaDmg('/release/Agent Time.dmg', credentials, rejected), /Invalid/);
  assert.equal(calls.length, 1);
});

test('transient Apple ticket connection loss retries stapling without resubmitting the DMG', () => {
  const calls: string[] = [];
  const delays: number[] = [];
  const run = (_command: string, args: string[]) => {
    calls.push(args[0]);
    if (args[0] === 'notarytool') return JSON.stringify({status: 'Accepted'});
    if (calls.filter(command => command === 'stapler').length === 1) {
      const error = new Error('Apple ticket service unavailable');
      (error as Error & {stderr: string}).stderr = 'NSURLErrorDomain Code=-1005 The network connection was lost';
      throw error;
    }
    return '';
  };
  notarizeBetaDmg('/release/Agent Time.dmg', credentials, run, delay => delays.push(delay));
  assert.deepEqual(calls, ['notarytool', 'stapler', 'stapler']);
  assert.deepEqual(delays, [5000]);
});

test('transient Apple ticket connection loss retries staple validation', () => {
  const calls: string[][] = [];
  const delays: number[] = [];
  const run = (_command: string, args: string[]) => {
    calls.push(args);
    if (calls.length === 1) {
      const error = new Error('Apple ticket service unavailable');
      (error as Error & {stderr: string}).stderr = 'NSURLErrorDomain Code=-1005 The network connection was lost';
      throw error;
    }
    return '';
  };
  validateStaple('/release/Agent Time.app', run, delay => delays.push(delay));
  assert.deepEqual(calls, [
    ['stapler', 'validate', '/release/Agent Time.app'],
    ['stapler', 'validate', '/release/Agent Time.app'],
  ]);
  assert.deepEqual(delays, [5000]);
});

test('a timed-out DMG wait resumes the existing Apple submission', () => {
  const calls: string[] = [];
  const delays: number[] = [];
  const id = '06780ab0-ae4e-48b0-99c7-574b880cefa2';
  const run = (_command: string, args: string[]) => {
    calls.push(args[0]);
    if (args[0] === 'notarytool' && args[1] === 'submit') {
      throw new Error(`NSURLErrorDomain Code=-1001 https://appstoreconnect.apple.com/notary/v2/submissions/${id}?`);
    }
    if (args[0] === 'notarytool' && args[1] === 'info') {
      assert.equal(args[2], id);
      return JSON.stringify({status: calls.filter(call => call === 'notarytool').length === 2 ? 'In Progress' : 'Accepted'});
    }
    return '';
  };
  notarizeBetaDmg('/release/Agent Time.dmg', credentials, run, delay => delays.push(delay));
  assert.deepEqual(calls, ['notarytool', 'notarytool', 'notarytool', 'stapler']);
  assert.deepEqual(delays, [10000]);
});

test('staple validation fails immediately on a permanent error', () => {
  let calls = 0;
  const run = () => { calls++; throw new Error('Ticket not found'); };
  assert.throws(() => validateStaple('/release/Agent Time.app', run), /Ticket not found/);
  assert.equal(calls, 1);
});

test('Apple ID notarization requires a Keychain profile so its password is not passed on the command line', () => {
  const run = () => JSON.stringify({status: 'Accepted'});
  assert.throws(() => notarizeBetaDmg('/release/Agent Time.dmg', {APPLE_ID: 'owner@example.test'}, run), /Keychain profile/);
});
