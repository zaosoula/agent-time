import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (process.platform !== 'darwin') throw new Error('The desktop app build requires macOS');

let identity = process.env.APPLE_SIGNING_IDENTITY;
if (!identity) {
  const result = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || 'Could not inspect code signing identities');
  identity = result.stdout.match(/^\s*\d+\)\s+([A-F\d]{40})\s+"Apple Development:[^"]+"/m)?.[1];
}
if (!identity || identity === '-') {
  throw new Error('An Apple Development signing identity is required for stable macOS Accessibility permission. Set APPLE_SIGNING_IDENTITY to one from security find-identity -v -p codesigning.');
}

run('npm', ['run', 'sidecars:build']);
// The embedded Node collector needs V8 executable memory. Keep the local
// development bundle signed for TCC, without enabling Hardened Runtime on Node.
run('npm', ['run', 'tauri', '--', 'build', '--bundles', 'app', '--config', JSON.stringify({ bundle: { macOS: { hardenedRuntime: false } } })], {
  env: { ...process.env, APPLE_SIGNING_IDENTITY: identity },
});
const app = 'src-tauri/target/release/bundle/macos/Agent Time.app';
const agents = `${app}/Contents/Library/LaunchAgents`;
mkdirSync(agents, { recursive: true });
copyFileSync('native/studio.ezyo.agenttime.startup.plist', `${agents}/studio.ezyo.agenttime.startup.plist`);
run('plutil', ['-lint', `${agents}/studio.ezyo.agenttime.startup.plist`]);
run('codesign', ['--force', '--sign', identity, app]);
run('codesign', ['--verify', '--deep', '--strict', app]);
