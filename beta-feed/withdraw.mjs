import assert from 'node:assert/strict';

const expected = process.env.EXPECTED_VERSION;
const token = process.env.FEED_UPLOAD_TOKEN?.trim();
assert.match(expected || '', /^\d+\.\d+\.\d+-beta\.\d+$/);
assert.ok(token && token.length >= 32, 'Feed upload token is required');
const publicOrigin = 'https://agent-time.ezyostudio.com';
const uploadOrigin = 'https://agent-time-origin.ezyostudio.com';
const live = await fetch(publicOrigin + '/beta/latest.json', { cache: 'no-store' });
assert.equal(live.status, 200, 'Inspect the current public release before withdrawal');
assert.equal((await live.json()).version, expected, 'Refusing to withdraw a different public version');
for (const [method, path] of [['POST', '/admin/manifest/withdraw'], ['DELETE', '/admin/installers/current']]) {
  const response = await fetch(uploadOrigin + path, { method, headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 204, `Withdrawal failed at ${path}; inspect live state before retrying`);
}
console.log(`Withdrew updater and installer for ${expected}`);
