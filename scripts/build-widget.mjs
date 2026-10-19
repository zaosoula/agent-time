import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Widget builds require Apple Silicon macOS');
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
if (!/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/.test(version)) throw new Error(`Unsupported widget version: ${version}`);
const source = resolve('.capture/widget-build/Build/Products/Release/AgentTimeWidget.appex');
const target = resolve('src-tauri/widget/AgentTimeWidget.appex');
const selected = process.env.APPLE_SIGNING_IDENTITY;
if (selected) {
  const identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  if (!identities.split('\n').some(line => line.includes(selected))) throw new Error('Widget signing identity is unavailable');
}
const widgetEntitlements = resolve('.capture/widget-entitlements.plist');
const hostEntitlements = resolve('src-tauri/widget/host.entitlements');
mkdirSync(resolve('src-tauri/widget'), { recursive: true });
execFileSync('xcodebuild', [
  '-quiet', '-project', 'native/widget/AgentTimeWidget.xcodeproj', '-scheme', 'AgentTimeWidget',
  '-configuration', 'Release', '-sdk', 'macosx', '-arch', 'arm64',
  '-derivedDataPath', resolve('.capture/widget-build'), 'CODE_SIGNING_ALLOWED=NO',
  `MARKETING_VERSION=${version}`, `CURRENT_PROJECT_VERSION=${version}`, 'build',
], { stdio: 'inherit' });
rmSync(target, { recursive: true, force: true });
mkdirSync(resolve('src-tauri/widget'), { recursive: true });
cpSync(source, target, { recursive: true });
let team = 'XSA5KG6XNB';
if (process.env.APPLE_SIGNING_IDENTITY) {
  // Certificate display names can contain an ID different from the actual signing Team ID.
  execFileSync('codesign', ['--force', '--sign', selected, target], { stdio: 'inherit' });
  const inspection = spawnSync('codesign', ['-dv', '--verbose=4', target], { encoding: 'utf8' });
  if (inspection.status !== 0) throw new Error('Could not inspect widget signing identity');
  const details = inspection.stdout + inspection.stderr;
  team = details.match(/TeamIdentifier=([A-Z0-9]{10})/)?.[1] || '';
  if (!team) throw new Error('Could not read widget signing Team ID');
}
const group = `${team}.studio.ezyo.agenttime`;
const withGroup = file => readFileSync(file, 'utf8').replaceAll('XSA5KG6XNB.studio.ezyo.agenttime', group);
writeFileSync(widgetEntitlements, withGroup('native/widget/Widget.entitlements'));
writeFileSync(hostEntitlements, withGroup('src-tauri/entitlements.beta.plist'));
if (process.env.APPLE_SIGNING_IDENTITY) {
  const args = ['--force', '--sign', process.env.APPLE_SIGNING_IDENTITY, '--options', 'runtime', '--entitlements', widgetEntitlements];
  if (process.env.AGENT_TIME_BETA === '1') args.push('--timestamp');
  args.push(target);
  execFileSync('codesign', args, { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--strict', '--verbose=2', target], { stdio: 'inherit' });
}
console.log(`Built Agent Time widget ${version}`);
