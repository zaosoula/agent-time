import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {isNewerBetaVersion} from './beta-manifest.mjs';

const [directoryArgument] = process.argv.slice(2);
const directory = resolve(directoryArgument || 'beta-out');
const origin = 'https://agent-time.ezyostudio.com';
const uploadOrigin = 'https://agent-time-origin.ezyostudio.com';
const token = process.env.FEED_UPLOAD_TOKEN?.trim();
if (!token || token.length < 32) throw new Error('A strong feed upload token is required');
const metadata = JSON.parse(await readFile(join(directory, 'release-metadata.json'), 'utf8'));
const {version, commit, archiveSha256, dmgSha256, manifest} = metadata;
if (!/^\d+\.\d+\.\d+-beta\.\d+$/.test(version) || version !== process.env.EXPECTED_VERSION || commit !== process.env.GITHUB_SHA) {
  throw new Error('Release artifact version or source revision does not match this workflow');
}
const archiveName = 'Agent Time.app.tar.gz';
const dmgName = `Agent Time_${version}_aarch64.dmg`;
const archivePath = `/beta/${version}/${encodeURIComponent(archiveName)}`;
const dmgPath = `/install/${version}/${encodeURIComponent(dmgName)}`;
const archive = await readFile(join(directory, version, archiveName));
const signature = await readFile(join(directory, version, `${archiveName}.sig`));
const dmg = await readFile(join(directory, dmgName));
const candidate = await readFile(join(directory, 'latest.json.candidate'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
if (sha256(archive) !== archiveSha256 || sha256(dmg) !== dmgSha256 ||
  manifest?.version !== version || manifest?.platforms?.['darwin-aarch64']?.url !== origin + archivePath ||
  manifest?.platforms?.['darwin-aarch64']?.signature !== signature.toString('utf8').trim() ||
  JSON.stringify(JSON.parse(candidate.toString('utf8'))) !== JSON.stringify(manifest)) {
  throw new Error('Release artifact hashes, manifest, or updater signature do not match');
}

const live = await fetch(origin + '/beta/latest.json', {cache: 'no-store'});
if (live.ok && live.status !== 204) {
  const current = await live.json();
  if (!isNewerBetaVersion(version, current.version || '')) {
    throw new Error('The live updater version is not older than this release');
  }
} else if (live.status !== 204 && live.status !== 404) throw new Error(`Could not inspect live updater feed: HTTP ${live.status}`);

async function upload(path, body) {
  const response = await fetch(uploadOrigin + path, {
    method: 'PUT',
    headers: {Authorization: `Bearer ${token}`, 'X-Content-SHA256': sha256(body)},
    body,
  });
  if (response.status !== 201) throw new Error(`Release upload failed at ${path}: HTTP ${response.status}`);
}
async function checkedDownload(path, digest) {
  const response = await fetch(origin + path, {cache: 'no-store'});
  if (!response.ok || sha256(Buffer.from(await response.arrayBuffer())) !== digest) throw new Error(`Hosted artifact mismatch at ${path}`);
}
await upload(`/admin/releases/${version}/${encodeURIComponent(archiveName)}`, archive);
await upload(`/admin/releases/${version}/${encodeURIComponent(`${archiveName}.sig`)}`, signature);
await upload(`/admin/installers/${version}/${encodeURIComponent(dmgName)}`, dmg);
await checkedDownload(archivePath, archiveSha256);
await checkedDownload(`${archivePath}.sig`, sha256(signature));
await upload('/admin/manifest/candidate', candidate);

const promoted = await fetch(uploadOrigin + '/admin/manifest/promote', {method: 'POST', headers: {Authorization: `Bearer ${token}`}});
if (promoted.status !== 204) throw new Error(`Updater promotion failed: HTTP ${promoted.status}`);
const selected = await fetch(uploadOrigin + '/admin/installers/current', {
  method: 'PUT', headers: {Authorization: `Bearer ${token}`, 'X-Content-SHA256': sha256(Buffer.from(version))}, body: version,
});
if (selected.status !== 204) throw new Error(`Installer selection failed: HTTP ${selected.status}`);
const published = await fetch(origin + '/beta/latest.json', {cache: 'no-store'});
if (!published.ok || JSON.stringify(await published.json()) !== JSON.stringify(manifest)) throw new Error('Live updater manifest differs from the approved candidate');
await checkedDownload(dmgPath, dmgSha256);
console.log(JSON.stringify({version, commit, archiveSha256, dmgSha256, updateUrl: origin + '/beta/latest.json', downloadUrl: origin + dmgPath}));
