import assert from 'node:assert/strict';
import test from 'node:test';
import {betaBundleEnvironment, notarizeBetaDmg} from '../scripts/beta-release-steps.mjs';

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

test('Apple ID notarization requires a Keychain profile so its password is not passed on the command line', () => {
  const run = () => JSON.stringify({status: 'Accepted'});
  assert.throws(() => notarizeBetaDmg('/release/Agent Time.dmg', {APPLE_ID: 'owner@example.test'}, run), /Keychain profile/);
});
