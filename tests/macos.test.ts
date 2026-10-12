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
