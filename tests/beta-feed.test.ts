import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createBetaFeed, createInstallLink, createInvitePageLink} from '../beta-feed/server.mjs';

const version = '0.2.0-beta.1';
const archiveName = 'Agent Time.app.tar.gz';
const origin = 'https://agent-time.ezyostudio.com';
const token = 'test-token-'.repeat(5);
const sha = (body: string) => createHash('sha256').update(body).digest('hex');

test('the live feed stays absent until signed artifacts and a candidate are explicitly promoted', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-time-feed-'));
  const server = createServer(createBetaFeed({dataDir, uploadToken: token, inviteSigningKey: 'invite-key-'.repeat(5), publicOrigin: origin}));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const auth = {Authorization: `Bearer ${token}`};
  const put = (path: string, body: string, authorized = true) => fetch(base + path, {
    method: 'PUT',
    headers: {...(authorized ? auth : {}), 'X-Content-SHA256': sha(body)},
    body,
  });
  try {
    assert.equal((await fetch(base + '/beta/latest.json')).status, 404);
    const archivePath = `/admin/releases/${version}/${encodeURIComponent(archiveName)}`;
    assert.equal((await put(archivePath, 'archive bytes', false)).status, 401);
    assert.equal((await put(archivePath, 'archive bytes')).status, 201);
    assert.equal((await put(archivePath, 'replacement')).status, 409);
    assert.equal(await (await fetch(base + `/beta/${version}/${encodeURIComponent(archiveName)}`)).text(), 'archive bytes');
    assert.equal((await put(`${archivePath}.sig`, 'signed archive')).status, 201);

    const manifest = JSON.stringify({version, notes: 'First beta', platforms: {'darwin-aarch64': {
      url: `${origin}/beta/${version}/${encodeURIComponent(archiveName)}`,
      signature: 'signed archive',
    }}});
    assert.equal((await put('/admin/manifest/candidate', manifest)).status, 201);
    assert.equal((await fetch(base + '/beta/latest.json')).status, 404);
    assert.equal((await fetch(base + '/beta/latest.json.candidate')).status, 404);
    assert.equal((await fetch(base + '/admin/manifest/promote', {method: 'POST'})).status, 401);
    assert.equal((await fetch(base + '/admin/manifest/promote', {method: 'POST', headers: auth})).status, 204);
    const live = await fetch(base + '/beta/latest.json');
    assert.equal(live.status, 200);
    assert.equal(live.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await live.json(), JSON.parse(manifest));
    assert.equal((await fetch(base + '/beta/not-a-version/file')).status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(dataDir, {recursive: true, force: true});
  }
});

test('bad bytes and a manifest with an external archive cannot be staged', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-time-feed-'));
  const server = createServer(createBetaFeed({dataDir, uploadToken: token, inviteSigningKey: 'invite-key-'.repeat(5), publicOrigin: origin}));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const badArchive = await fetch(base + `/admin/releases/${version}/${encodeURIComponent(archiveName)}`, {
      method: 'PUT', headers: {Authorization: `Bearer ${token}`, 'X-Content-SHA256': sha('different')}, body: 'archive bytes',
    });
    assert.equal(badArchive.status, 422);
    assert.equal((await fetch(base + `/beta/${version}/${encodeURIComponent(archiveName)}`)).status, 404);
    const badManifest = JSON.stringify({version, notes: '', platforms: {'darwin-aarch64': {url: 'https://wrong.example/beta/file', signature: 'x'}}});
    const candidate = await fetch(base + '/admin/manifest/candidate', {
      method: 'PUT', headers: {Authorization: `Bearer ${token}`, 'X-Content-SHA256': sha(badManifest)}, body: badManifest,
    });
    assert.equal(candidate.status, 422);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(dataDir, {recursive: true, force: true});
  }
});

test('a first-install DMG needs an expiring private link', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-time-feed-'));
  const server = createServer(createBetaFeed({dataDir, uploadToken: token, publicOrigin: origin, inviteSigningKey: 'invite-key-'.repeat(5)}));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const name = `Agent Time_${version}_aarch64.dmg`;
  const path = `/install/${version}/${encodeURIComponent(name)}`;
  try {
    const publicPage = await (await fetch(base + '/')).text();
    assert.match(publicPage, /See where your work time goes/);
    assert.doesNotMatch(publicPage, /Download Agent Time for Mac/);
    assert.match(publicPage, /noindex, nofollow/);
    assert.match(publicPage, /Skip to content/);
    assert.match(publicPage, /Beta data notice/);
    assert.equal((await fetch(base + '/manrope.ttf')).status, 200);
    assert.equal((await fetch(base + path)).status, 403);
    const upload = await fetch(base + `/admin/installers/${version}/${encodeURIComponent(name)}`, {
      method: 'PUT', headers: {Authorization: `Bearer ${token}`, 'X-Content-SHA256': sha('notarized DMG')}, body: 'notarized DMG',
    });
    assert.equal(upload.status, 201);
    const future = Math.floor(Date.now() / 1000) + 3600;
    const link = createInstallLink({publicOrigin: origin, inviteSigningKey: 'invite-key-'.repeat(5), version, expires: future, nonce: 'friend-1'});
    const pageLink = createInvitePageLink({publicOrigin: origin, inviteSigningKey: 'invite-key-'.repeat(5), version, expires: future, nonce: 'friend-1'});
    const invitePage = await (await fetch(base + new URL(pageLink).search)).text();
    assert.match(invitePage, /Download Agent Time for Mac/);
    assert.ok(invitePage.includes(link.replaceAll('&', '&amp;')));
    const privatePath = new URL(link).pathname + new URL(link).search;
    const download = await fetch(base + privatePath);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('cache-control'), 'private, no-store');
    assert.equal(await download.text(), 'notarized DMG');
    assert.equal((await fetch(base + privatePath.replace('friend-1', 'friend-2'))).status, 403);
    const expired = createInstallLink({publicOrigin: origin, inviteSigningKey: 'invite-key-'.repeat(5), version, expires: 1, nonce: 'old'});
    assert.equal((await fetch(base + new URL(expired).pathname + new URL(expired).search)).status, 403);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(dataDir, {recursive: true, force: true});
  }
});
