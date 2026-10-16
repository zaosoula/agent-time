import {createHash} from 'node:crypto';
import {copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {basename, join, resolve} from 'node:path';
import {stageBetaRelease} from './publish-beta.mjs';

const [outputArgument] = process.argv.slice(2);
const output = resolve(outputArgument || 'beta-out');
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const tauri = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
const cargo = readFileSync('src-tauri/Cargo.toml', 'utf8').match(/^version = "([^"]+)"/m)?.[1];
const cargoLock = readFileSync('src-tauri/Cargo.lock', 'utf8').match(/\[\[package\]\]\nname = "agent-time"\nversion = "([^"]+)"/)?.[1];
const version = packageJson.version;
if (!/^\d+\.\d+\.\d+-beta\.\d+$/.test(version) ||
  [lock.version, lock.packages?.['']?.version, tauri.version, cargo, cargoLock, process.env.EXPECTED_VERSION].some(value => value !== version)) {
  throw new Error('Release version differs across package, Tauri, Cargo, lockfiles, or workflow input');
}
if (process.argv.includes('--check-version')) {
  console.log(`Release version verified: ${version}`);
  process.exit(0);
}
if (!process.env.GITHUB_SHA || !/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA)) throw new Error('A GitHub source revision is required');
const notes = process.env.RELEASE_NOTES?.trim();
if (!notes) throw new Error('Release notes are required');

const bundle = resolve('src-tauri/target/aarch64-apple-darwin/release/bundle');
function one(folder, suffix) {
  const matches = readdirSync(folder).filter(name => name.endsWith(suffix));
  if (matches.length !== 1) throw new Error(`Expected one ${suffix} in ${folder}`);
  return join(folder, matches[0]);
}
const archive = one(join(bundle, 'macos'), '.app.tar.gz');
const dmg = one(join(bundle, 'dmg'), '.dmg');
const expectedDmg = `Agent Time_${version}_aarch64.dmg`;
if (basename(dmg) !== expectedDmg) throw new Error('DMG name does not match the release version');
const publicOrigin = 'https://agent-time.ezyostudio.com';
const archiveUrl = `${publicOrigin}/beta/${version}/${encodeURIComponent('Agent Time.app.tar.gz')}`;
mkdirSync(output, {recursive: true});
stageBetaRelease({version, archive, signaturePath: `${archive}.sig`, notes, archiveUrl, output});
copyFileSync(dmg, join(output, expectedDmg));
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const manifest = JSON.parse(readFileSync(join(output, 'latest.json.candidate'), 'utf8'));
const metadata = {version, commit: process.env.GITHUB_SHA, archiveSha256: sha256(archive), dmgSha256: sha256(dmg), manifest};
writeFileSync(join(output, 'release-metadata.json'), JSON.stringify(metadata, null, 2) + '\n', {flag: 'wx'});
console.log(JSON.stringify({version, commit: metadata.commit, archiveSha256: metadata.archiveSha256, dmgSha256: metadata.dmgSha256}));
