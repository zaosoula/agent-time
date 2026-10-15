import {test} from 'node:test';
import assert from 'node:assert/strict';
import {diagnosticSummary} from '../src/capture/diagnostics.ts';
test('support diagnostics exclude captured work, paths, URLs, and raw errors',()=>{
 const secret='TOP_SECRET_PROMPT';
 const input={
  status:{running:true,eventCount:17,lastPoll:1000,lastError:`Could not read /private/${secret}`,surfaces:{claudeHooks:true},sources:[{id:'claude',kind:'agent',setting:'claudeHooks',name:'Claude'}],output:'/private/work',macos:{browserUrl:`https://example.test/${secret}`,windowTitle:secret}},
  health:{latest:{claude:995},hooks:{claude:{installed:1,total:1,needsAttention:false}},events:[{detail:secret}],websites:[{key:`https://example.test/${secret}`}]},
  hooks:{runtimeReady:true,targets:[{provider:'claude',state:'installed',path:`/private/${secret}`,error:secret}]},
  databaseBytes:1234,databaseHealthy:true,now:1005,
 };
 const summary=diagnosticSummary(input);
 const text=JSON.stringify(summary);
 for(const value of [secret,'/private/','https://example.test','windowTitle','error:'])assert.equal(text.includes(value),false);
 assert.equal(summary.databaseBytes,1234);
 assert.equal(summary.databaseHealth,'ok');
 assert.equal(summary.sources[0].lastEventAgeSeconds,10);
 assert.equal(summary.sources[0].hooks,'installed');
});
