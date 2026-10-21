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
