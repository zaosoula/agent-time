const developerIdentity = /^\s*\d+\)\s+([A-F\d]{40})\s+"(Developer ID Application:[^"]+)"/gm;

export function betaBuildConfig(env, identityList, platform = process.platform, arch = process.arch) {
  if (platform !== 'darwin' || arch !== 'arm64') throw new Error('Apple Silicon macOS is required for the beta build');
  const selected = env.APPLE_SIGNING_IDENTITY?.trim();
  const identities = [...identityList.matchAll(developerIdentity)];
  const matching = identities.find(([, hash, name]) => selected === hash || selected === name);
  if (!matching) throw new Error('A valid Developer ID Application signing identity is required');
  const hasApiCredentials = [env.APPLE_API_ISSUER, env.APPLE_API_KEY, env.APPLE_API_KEY_PATH].every(value => value?.trim());
  const hasAppleIdCredentials = [env.APPLE_ID, env.APPLE_PASSWORD, env.APPLE_TEAM_ID].every(value => value?.trim());
  if (!hasApiCredentials && !hasAppleIdCredentials) {
    throw new Error('Apple notarization API or app-specific password credentials are required');
  }
  if (!hasApiCredentials && !env.APPLE_NOTARY_KEYCHAIN_PROFILE?.trim()) {
    throw new Error('Apple ID DMG notarization requires a Keychain profile');
  }
  if (!env.TAURI_SIGNING_PRIVATE_KEY?.trim()) throw new Error('The updater private signing key is required');
  if (!env.BETA_UPDATER_PUBLIC_KEY?.trim()) throw new Error('The updater public key is required');
  let url;
  try { url = new URL(env.BETA_UPDATE_URL); } catch { throw new Error('An HTTPS beta update URL is required'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('An HTTPS beta update URL without embedded credentials is required');
  return {
    bundle: {
      targets: ['app', 'dmg'],
      createUpdaterArtifacts: true,
      macOS: {
        hardenedRuntime: true,
        entitlements: './entitlements.beta.plist',
        minimumSystemVersion: '13.5',
        signingIdentity: matching[1],
        files: {
          'Library/LaunchAgents/studio.ezyo.agenttime.startup.plist': '../native/studio.ezyo.agenttime.startup.plist',
          'PlugIns/AgentTimeWidget.appex': 'widget/AgentTimeWidget.appex',
        },
      },
    },
    plugins: { updater: { pubkey: env.BETA_UPDATER_PUBLIC_KEY.trim(), endpoints: [url.href] } },
  };
}
