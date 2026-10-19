import {test} from 'node:test';
import assert from 'node:assert/strict';
import {betaBuildConfig} from '../scripts/beta-config.mjs';
const identities='  1) 1234567890ABCDEF1234567890ABCDEF12345678 "Apple Development: Example"\n  2) ABCDEF1234567890ABCDEF1234567890ABCDEF12 "Developer ID Application: Example (TEAM123456)"\n';
const env={APPLE_SIGNING_IDENTITY:'ABCDEF1234567890ABCDEF1234567890ABCDEF12',BETA_UPDATE_URL:'https://updates.example.test/beta/latest.json',BETA_UPDATER_PUBLIC_KEY:'public-key',TAURI_SIGNING_PRIVATE_KEY:'/secure/updater.key',APPLE_API_ISSUER:'issuer',APPLE_API_KEY:'key-id',APPLE_API_KEY_PATH:'/secure/notary.p8'};
test('beta build selects only Developer ID and an Apple Silicon HTTPS update feed',()=>{
 const result=betaBuildConfig(env,identities,'darwin','arm64');
 assert.equal(result.bundle.macOS.hardenedRuntime,true);
 assert.equal(result.bundle.macOS.entitlements,'./entitlements.beta.plist');
 assert.equal(result.bundle.macOS.minimumSystemVersion,'13.5');
 assert.equal(result.bundle.createUpdaterArtifacts,true);
 assert.deepEqual(result.plugins.updater.endpoints,['https://updates.example.test/beta/latest.json']);
 assert.equal(result.plugins.updater.pubkey,'public-key');
 assert.equal(JSON.stringify(result).includes('/secure/updater.key'),false);
});
test('beta build refuses development signing, insecure feed, or missing release credentials',()=>{
 assert.throws(()=>betaBuildConfig({...env,APPLE_SIGNING_IDENTITY:'1234567890ABCDEF1234567890ABCDEF12345678'},identities,'darwin','arm64'),/Developer ID Application/);
 assert.throws(()=>betaBuildConfig({...env,BETA_UPDATE_URL:'http://updates.example.test/latest.json'},identities,'darwin','arm64'),/HTTPS/);
 assert.throws(()=>betaBuildConfig({...env,APPLE_API_KEY_PATH:''},identities,'darwin','arm64'),/notar/i);
 assert.throws(()=>betaBuildConfig(env,identities,'darwin','x64'),/Apple Silicon/);
});
test('Apple ID release builds require a DMG notarization Keychain profile before building',()=>{
 const apple={...env,APPLE_API_ISSUER:'',APPLE_API_KEY:'',APPLE_API_KEY_PATH:'',APPLE_ID:'owner@example.test',APPLE_PASSWORD:'app-password',APPLE_TEAM_ID:'TEAM123456'};
 assert.throws(()=>betaBuildConfig(apple,identities,'darwin','arm64'),/Keychain profile/);
 assert.ok(betaBuildConfig({...apple,APPLE_NOTARY_KEYCHAIN_PROFILE:'agent-time-notary'},identities,'darwin','arm64'));
});
