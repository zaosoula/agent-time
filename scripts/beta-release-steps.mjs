import {execFileSync} from 'node:child_process';

export function betaBundleEnvironment(env) {
  return {...env, CI: 'true', AGENT_TIME_BETA: '1', VITE_BETA_UPDATES: '1'};
}

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function retryAppleTicket(action, wait) {
  const maxAttempts = 8;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try { return action(); }
    catch (error) {
      const details = `${error?.message || ''}\n${error?.stdout || ''}\n${error?.stderr || ''}`;
      if (attempt === maxAttempts - 1 || !details.includes('Code=-1005')) throw error;
      wait(Math.min(30000, 5000 * (attempt + 1)));
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

  let output;
  try {
    output = execFile('xcrun', ['notarytool', 'submit', file, '--wait', '--output-format', 'json', ...auth], {encoding: 'utf8'});
  } catch (error) {
    const details = `${error?.message || ''}\n${error?.stdout || ''}\n${error?.stderr || ''}`;
    const id = details.match(/\/notary\/v2\/submissions\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/i)?.[1];
    if (!id || !/Code=-1001|Code=-1005/.test(details)) throw error;
    // Apple may have accepted the upload before its --wait request timed out.
    // Query the known submission instead of uploading a second copy.
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const info = execFile('xcrun', ['notarytool', 'info', id, '--output-format', 'json', ...auth], {encoding: 'utf8'});
        const status = JSON.parse(info).status;
        if (status === 'Accepted') { output = info; break; }
        if (status !== 'In Progress') throw new Error(`DMG notarization was ${status || 'unknown'}`);
      } catch (infoError) {
        const message = `${infoError?.message || ''}\n${infoError?.stderr || ''}`;
        if (!/Code=-1001|Code=-1005/.test(message)) throw infoError;
      }
      if (attempt === 29) throw new Error(`Timed out waiting for Apple DMG notarization submission ${id}`);
      wait(10000);
    }
  }
  let submission;
  try { submission = JSON.parse(output); }
  catch { throw new Error('Apple returned an unreadable DMG notarization result'); }
  if (submission.status !== 'Accepted') throw new Error(`DMG notarization was ${submission.status || 'unknown'}`);
  retryAppleTicket(() => execFile('xcrun', ['stapler', 'staple', file], {encoding: 'utf8'}), wait);
}
