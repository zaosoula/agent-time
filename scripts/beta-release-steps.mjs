import {execFileSync} from 'node:child_process';

export function betaBundleEnvironment(env) {
  return {...env, CI: 'true', AGENT_TIME_BETA: '1', VITE_BETA_UPDATES: '1'};
}

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function retryAppleTicket(action, wait) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return action(); }
    catch (error) {
      const details = `${error?.message || ''}\n${error?.stdout || ''}\n${error?.stderr || ''}`;
      if (attempt === 2 || !details.includes('Code=-1005')) throw error;
      wait(5000 * (attempt + 1));
    }
  }
}

export function validateStaple(file, execFile = execFileSync, wait = sleep) {
  retryAppleTicket(() => execFile('xcrun', ['stapler', 'validate', file], {encoding: 'utf8'}), wait);
}

export function notarizeBetaDmg(file, env, execFile = execFileSync, wait = sleep) {
  const api = [env.APPLE_API_KEY_PATH, env.APPLE_API_KEY, env.APPLE_API_ISSUER];
  const auth = api.every(value => value?.trim())
    ? ['--key', api[0], '--key-id', api[1], '--issuer', api[2]]
    : env.APPLE_NOTARY_KEYCHAIN_PROFILE?.trim()
      ? ['--keychain-profile', env.APPLE_NOTARY_KEYCHAIN_PROFILE.trim()]
      : null;
  if (!auth) throw new Error('DMG notarization requires the team API key or a Keychain profile');

  const output = execFile('xcrun', ['notarytool', 'submit', file, '--wait', '--output-format', 'json', ...auth], {encoding: 'utf8'});
  let submission;
  try { submission = JSON.parse(output); }
  catch { throw new Error('Apple returned an unreadable DMG notarization result'); }
  if (submission.status !== 'Accepted') throw new Error(`DMG notarization was ${submission.status || 'unknown'}`);
  retryAppleTicket(() => execFile('xcrun', ['stapler', 'staple', file], {encoding: 'utf8'}), wait);
}
