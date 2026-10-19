export interface BetaBuildConfig {
 bundle: {
  targets: string[];
  createUpdaterArtifacts: boolean;
  macOS: { hardenedRuntime: boolean; entitlements: string; minimumSystemVersion: string; signingIdentity: string; files: Record<string,string> };
 };
 plugins: { updater: { pubkey: string; endpoints: string[] } };
}
export function betaBuildConfig(env: Record<string,string|undefined>, identityList: string, platform?: string, arch?: string): BetaBuildConfig;
