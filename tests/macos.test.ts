import { test } from 'node:test';import assert from 'node:assert/strict';
import { normalizeActivity } from '../src/capture/macos.ts';
test('invalid or impossible idle stays unknown',()=>{
 for(const idleSeconds of [-1,NaN,Infinity,5000]){
  const e=normalizeActivity({foregroundBundleId:'test',idleSeconds,uptime:100,observedAt:10},{collectorEpoch:'a'});
  assert.equal(e.data?.idleSeconds,null);assert.equal(e.data?.idleStatus,'unknown');
 }
});
test('foreground remains available without accessibility; no guessed session',()=>{
 const e=normalizeActivity({foregroundBundleId:'test',idleSeconds:2,uptime:100,observedAt:10,accessibilityTrusted:false},{});
 assert.equal(e.data?.foregroundBundleId,'test');assert.equal(e.data?.accessibilityTrusted,false);assert.equal(e.sessionId,undefined);
});
test('sleep event is preserved',()=>assert.equal(normalizeActivity({kind:'sleep',observedAt:10},{}).kind,'sleep'));
test('selected Orca worktree ID is retained as observed context',()=>{
 const e=normalizeActivity({foregroundBundleId:'com.stablyai.orca',orcaSelectedWorktreeId:'repo::/workspace',idleSeconds:0,uptime:10},{});
 assert.equal(e.data?.orcaSelectedWorktreeId,'repo::/workspace');
 assert.equal(e.workspaceId,undefined);
});
test('browser capture keeps a page URL and title only with a matching domain',()=>{
 const base={foregroundBundleId:'com.apple.Safari',idleSeconds:0,uptime:10};
 const accepted=normalizeActivity({...base,browserDomain:'github.com',browserUrl:'https://github.com/org/repo?tab=issues',browserTitle:'Issues'},{});
 assert.equal(accepted.data?.browserDomain,'github.com');
 assert.equal(accepted.data?.browserUrl,'https://github.com/org/repo?tab=issues');
 assert.equal(accepted.data?.browserTitle,'Issues');
 assert.equal(normalizeActivity({...base,browserDomain:'github.com/private?token=secret'},{}).data?.browserDomain,undefined);
 assert.equal(normalizeActivity({...base,browserDomain:'github.com',browserUrl:'https://other.com/path'},{}).data?.browserUrl,undefined);
 assert.equal(normalizeActivity({...base,browserDomain:'github.com',browserUrl:'https://user:pass@github.com/path'},{}).data?.browserUrl,undefined);
 assert.equal(normalizeActivity({...base,foregroundBundleId:'com.stablyai.orca',browserDomain:'github.com',browserUrl:'https://github.com/'},{}).data?.browserDomain,undefined);
});
