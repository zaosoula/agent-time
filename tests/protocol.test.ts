import { test } from 'node:test';import assert from 'node:assert/strict';
import { dispatchRequest } from '../src/capture/protocol.ts';
test('protocol limits methods and parameters and correlates reply IDs',async()=>{
 let starts=0;const c={status:()=>({running:false}),summary:()=>({}),start:async()=>{starts++;return {running:true};},stop:async()=>({running:false})};
 assert.deepEqual(await dispatchRequest({id:'1',method:'status'},c),{id:'1',result:{running:false}});
 assert.ok('error' in await dispatchRequest({id:'2',method:'exec',params:{command:'rm'}},c));
 for(const duration of [-1,0,NaN,Infinity,100000])assert.ok('error' in await dispatchRequest({id:'3',method:'start',params:{durationSeconds:duration}},c));
 assert.ok('error' in await dispatchRequest({id:'4',method:'start',params:{durationSeconds:10,path:'/arbitrary'}},c));
 await dispatchRequest({id:'5',method:'start',params:{durationSeconds:10}},c);assert.equal(starts,1);
});
test('settings protocol accepts only boolean surface controls',async()=>{
 let changed=0;const c={status:()=>({}),summary:()=>({}),start:async()=>({}),stop:async()=>({}),updateSettings:()=>{changed++;return {saved:true};}};
 assert.deepEqual(await dispatchRequest({id:'1',method:'settings',params:{claudeHooks:false}},c),{id:'1',result:{saved:true}});
 for(const params of [{orcaPolling:'true'},{path:'/tmp'},{toString:true},null,[]])assert.ok('error' in await dispatchRequest({id:'2',method:'settings',params},c));
 assert.equal(changed,1);
});
test('hook setup only accepts fixed provider operations and no filesystem arguments',async()=>{
 let installs=0;const c={status:()=>({}),summary:()=>({}),start:async()=>({}),stop:async()=>({}),hooksStatus:()=>({setupSeen:false}),installHooks:async(provider:string)=>{installs++;return {provider};},dismissHookSetup:()=>({setupSeen:true}),verifyHooks:()=>({verified:true})};
 assert.deepEqual(await dispatchRequest({id:'h',method:'hooks_status'},c),{id:'h',result:{setupSeen:false}});
 for(const params of [{provider:'other'},{provider:'claude',path:'/tmp/arbitrary'},{}])assert.ok('error' in await dispatchRequest({id:'h',method:'hooks_install',params},c));
 assert.equal(installs,0);assert.deepEqual(await dispatchRequest({id:'h',method:'hooks_install',params:{provider:'claude'}},c),{id:'h',result:{provider:'claude'}});
 assert.deepEqual(await dispatchRequest({id:'h',method:'hooks_dismiss'},c),{id:'h',result:{setupSeen:true}});
 assert.ok('error' in await dispatchRequest({id:'h',method:'hooks_verify',params:{command:'anything'}},c));
});
test('tracking cleanup requires explicit confirmation and rejects arbitrary paths',async()=>{
 let removed=0;const c={status:()=>({}),summary:()=>({}),start:async()=>({}),stop:async()=>({}),cleanupPreview:()=>({configurations:[]}),cleanupTracking:()=>{removed++;return {removed:true};}};
 assert.ok('result' in await dispatchRequest({id:'p',method:'tracking_cleanup_preview'},c));assert.equal(removed,0);
 for(const params of [{},{confirmed:false},{confirmed:true,path:'/tmp'},{confirmed:'true'}])assert.ok('error' in await dispatchRequest({id:'c',method:'tracking_cleanup',params},c));
 assert.equal(removed,0);assert.ok('result' in await dispatchRequest({id:'c',method:'tracking_cleanup',params:{confirmed:true}},c));assert.equal(removed,1);
});
