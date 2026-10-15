import { test } from 'node:test';import assert from 'node:assert/strict';
import { dispatchRequest } from '../src/capture/protocol.ts';
test('protocol limits methods and parameters and correlates reply IDs',async()=>{
 let starts=0;const c={status:()=>({running:false}),summary:()=>({}),start:async()=>{starts++;return {running:true};},stop:async()=>({running:false})};
 assert.deepEqual(await dispatchRequest({id:'1',method:'status'},c),{id:'1',result:{running:false}});
 assert.ok('error' in await dispatchRequest({id:'2',method:'exec',params:{command:'rm'}},c));
 for(const duration of [-1,0,NaN,Infinity,100000])assert.ok('error' in await dispatchRequest({id:'3',method:'start',params:{durationSeconds:duration}},c));
 assert.ok('error' in await dispatchRequest({id:'4',method:'start',params:{durationSeconds:10,path:'/arbitrary'}},c));
 assert.deepEqual(await dispatchRequest({id:'5',method:'start',params:{}},c),{id:'5',result:{running:true}});
 await dispatchRequest({id:'6',method:'start',params:{durationSeconds:10}},c);assert.equal(starts,2);
});
test('capture monitor is read-only and accepts no caller-controlled query',async()=>{
 let calls=0;const c={status:()=>({}),summary:()=>({}),captureHealth:()=>{calls++;return {events:[]};},start:async()=>({}),stop:async()=>({})};
 assert.deepEqual(await dispatchRequest({id:'health',method:'capture_health'},c),{id:'health',result:{events:[]}});
 assert.ok('error' in await dispatchRequest({id:'health',method:'capture_health',params:{limit:10000}},c));assert.equal(calls,1);
});
test('day summary requests remain bounded to a validated date',async()=>{
 const controller={status:()=>({}),summary:()=>({full:true}),summaryForDate:(date:string)=>({date}),start:async()=>({}),stop:async()=>({})};
 assert.deepEqual(await dispatchRequest({id:'day',method:'summary',params:{date:'2026-10-14'}},controller),{id:'day',result:{date:'2026-10-14'}});
 assert.ok('error' in await dispatchRequest({id:'day',method:'summary',params:{date:'2026-10-14',path:'/tmp'}},controller));
 assert.ok('error' in await dispatchRequest({id:'day',method:'summary',params:{date:42}},controller));
});
test('human review accepts bounded event pairs and rejects extra or malformed decisions',async()=>{
 let changes=0;
 const c={status:()=>({}),summary:()=>({}),start:async()=>({}),stop:async()=>({}),setHumanDecision:(pairs:Array<[string,string]>,mode:string,path?:string)=>{changes++;return {pairs,mode,path};}};
 assert.deepEqual(await dispatchRequest({id:'review',method:'human_decision_set',params:{pairs:[['a','b']],mode:'assigned',projectPath:'/project'}},c),{id:'review',result:{pairs:[['a','b']],mode:'assigned',path:'/project'}});
 for(const params of [
  {pairs:[],mode:'assigned',projectPath:'/project'},
  {pairs:[['a']],mode:'unassigned'},
  {pairs:[['a','b']],mode:'assigned'},
  {pairs:[['a','b']],mode:'clear',projectPath:'/project'},
  {pairs:[['a','b']],mode:'unknown'},
  {pairs:[['a','b']],mode:'unassigned',extra:true},
 ])assert.ok('error' in await dispatchRequest({id:'review',method:'human_decision_set',params},c));
 assert.equal(changes,1);
});
test('settings protocol accepts surface controls and bounded idle minutes',async()=>{
 let changed=0;const c={status:()=>({}),summary:()=>({}),start:async()=>({}),stop:async()=>({}),updateSettings:()=>{changed++;return {saved:true};}};
 assert.deepEqual(await dispatchRequest({id:'1',method:'settings',params:{claudeHooks:false}},c),{id:'1',result:{saved:true}});
  assert.deepEqual(await dispatchRequest({id:'idle',method:'settings',params:{humanIdleMinutes:5,agentIdleMinutes:10}},c),{id:'idle',result:{saved:true}});
  for(const params of [{orcaPolling:'true'},{path:'/tmp'},{toString:true},{humanIdleMinutes:0},{agentIdleMinutes:61},{agentIdleMinutes:'5'},null,[]])assert.ok('error' in await dispatchRequest({id:'2',method:'settings',params},c));
  assert.equal(changed,2);
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
test('Linear connection protocol accepts only a client ID and fixed read operations',async()=>{
 let connects=0;
 const c={status:()=>({}),summary:()=>({}),start:async()=>({}),stop:async()=>({}),linearStatus:async()=>({phase:'disconnected'}),linearConnect:async(clientId:string)=>{connects++;return {clientId};},linearSync:async(workspaceId?:string)=>({synced:workspaceId||'all'}),linearDisconnect:async(workspaceId?:string)=>({disconnected:workspaceId||'all'})};
 assert.deepEqual(await dispatchRequest({id:'l',method:'linear_status'},c),{id:'l',result:{phase:'disconnected'}});
 for(const params of [{},{clientId:123},{clientId:'valid-client',scope:'write'},{clientId:'valid-client',token:'secret'}])assert.ok('error' in await dispatchRequest({id:'l',method:'linear_connect',params},c));
 assert.equal(connects,0);
 assert.deepEqual(await dispatchRequest({id:'l',method:'linear_connect',params:{clientId:'valid-client'}},c),{id:'l',result:{clientId:'valid-client'}});
 assert.ok('error' in await dispatchRequest({id:'l',method:'linear_sync',params:{query:'mutation { anything }'}},c));
 assert.deepEqual(await dispatchRequest({id:'l',method:'linear_sync'},c),{id:'l',result:{synced:'all'}});
 assert.deepEqual(await dispatchRequest({id:'l',method:'linear_sync',params:{workspaceId:'one'}},c),{id:'l',result:{synced:'one'}});
 assert.deepEqual(await dispatchRequest({id:'l',method:'linear_disconnect',params:{workspaceId:'two'}},c),{id:'l',result:{disconnected:'two'}});
 for(const params of [{workspaceId:''},{workspaceId:1},{workspaceId:'one',all:true}])assert.ok('error' in await dispatchRequest({id:'l',method:'linear_disconnect',params},c));
});
