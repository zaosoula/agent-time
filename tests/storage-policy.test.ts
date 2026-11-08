import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readdirSync,mkdirSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {storagePolicyDecision,quickStorageUsage,estimatedBytes} from '../src/capture/storage-policy.ts';
import {Collector} from '../src/capture/collector.ts';import {validateSettings} from '../src/capture/settings.ts';
import {spoolHook,spoolStatus,importSpool,MAX_PENDING_HOOKS,MAX_HOOK_BYTES} from '../src/capture/hooks.ts';import {makeEvent} from '../src/capture/events.ts';import {EventStore} from '../src/capture/store.ts';
const GiB=1024**3;
test('storage care precedes pausing, with a disk reserve and validated configurable budget',()=>{
 assert.equal(storagePolicyDecision({managedBytes:GiB,freeBytes:3*GiB},5120),'ok');assert.equal(storagePolicyDecision({managedBytes:4.6*GiB,freeBytes:3*GiB},5120),'care');assert.equal(storagePolicyDecision({managedBytes:5*GiB,freeBytes:3*GiB},5120),'pause');assert.equal(storagePolicyDecision({managedBytes:1,freeBytes:GiB-1},5120),'pause');assert.equal(storagePolicyDecision({managedBytes:1,freeBytes:null},5120),'ok');
 assert.throws(()=>validateSettings({storageLimitMB:1023}));assert.throws(()=>validateSettings({storageLimitMB:1024.5}));assert.doesNotThrow(()=>validateSettings({storageLimitMB:5120}));
 const shared={value:'x'.repeat(100)};assert.ok(estimatedBytes({a:shared,b:shared})<estimatedBytes({a:shared,b:{...shared}}));assert.ok(estimatedBytes('x'.repeat(100),32)>32);
});
test('changing only storage budget emits no timing fence or capture event',async()=>{
 const root=mkdtempSync(join(tmpdir(),'at-budget-')),collector=new Collector(root);try{const before=collector.store.count();collector.updateSettings({storageLimitMB:6144});assert.equal(collector.store.count(),before);assert.equal(collector.status().surfaces.storageLimitMB,6144);assert.ok(quickStorageUsage(root).managedBytes>0);}finally{await collector.close();rmSync(root,{recursive:true,force:true});}
});
test('hook spool bounds new payloads and queued files, reports overflow and honors storage pause',()=>{
 const root=mkdtempSync(join(tmpdir(),'at-queue-')),folder=join(root,'spool'),store=new EventStore(join(root,'events.sqlite'));try{
 const event=makeEvent('hook','tool_start',{provider:'codex',sessionId:'s',data:{toolId:'t'}});assert.equal(spoolHook({...event,data:{extra:'x'.repeat(MAX_HOOK_BYTES)}},folder),false);
 mkdirSync(folder,{recursive:true});for(let i=0;i<MAX_PENDING_HOOKS;i++)writeFileSync(join(folder,`${i}.tmp`),'');assert.equal(spoolHook(event,folder),false);assert.ok(readdirSync(folder).length<=MAX_PENDING_HOOKS+1);assert.ok(importSpool(folder,store).some(issue=>/overflow|limit/i.test(issue.reason)));for(let i=0;i<MAX_PENDING_HOOKS;i++)rmSync(join(folder,`${i}.tmp`));
 writeFileSync(join(root,'storage-paused.json'),'{}');assert.equal(spoolHook(event,folder),false);rmSync(join(root,'storage-paused.json'));assert.equal(spoolHook(event,folder),true);assert.equal(spoolStatus(folder).pending,1);
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
test('quota pauses before new capture and resumes after capacity is recovered',async()=>{
 const {openSync,closeSync,ftruncateSync,existsSync}=await import('node:fs');const root=mkdtempSync(join(tmpdir(),'at-quota-pause-')),collector=new Collector(root);try{
 collector.updateSettings({storageLimitMB:1024,macosActivity:false,orcaPolling:false,tokenUsage:false});mkdirSync(join(root,'exports'));const path=join(root,'exports','protected-user-backup'),fd=openSync(path,'w');ftruncateSync(fd,1024**3);closeSync(fd);
 await assert.rejects(collector.start(),/storage budget/);assert.equal(collector.status().running,false);assert.ok(existsSync(join(root,'storage-paused.json')));assert.equal(collector.store.events().filter(e=>e.kind==='capture_start').length,0);rmSync(path);await collector.start(1);assert.equal(collector.status().running,true);assert.equal(existsSync(join(root,'storage-paused.json')),false);await collector.stop();
 }finally{await collector.close();rmSync(root,{recursive:true,force:true});}
});
test('summary cache eviction recomputes the same timing values within its memory budget',async()=>{
 const {DaySummaries}=await import('../src/capture/day-summaries.ts');const store=new EventStore(':memory:');try{
 for(const [id,date] of [['a','2026-10-20'],['b','2026-10-25']]){const at=new Date(date+'T12:00:00').getTime()/1000;store.put(makeEvent('macos','activity',{eventId:id+'1',observedAt:at,monotonicAt:at,data:{idleSeconds:0,foregroundName:'Editor'}}));store.put(makeEvent('macos','activity',{eventId:id+'2',observedAt:at+5,monotonicAt:at+5,data:{idleSeconds:0,foregroundName:'Editor'}}));}
 const cache=new DaySummaries(store,()=>({idleThreshold:300,agentIdleThreshold:300}),64),first=structuredClone(cache.window('2026-10-20').raw);cache.window('2026-10-25');assert.equal(cache.computations,2);assert.deepEqual(cache.window('2026-10-20').raw,first);assert.equal(cache.computations,3);
 }finally{store.close();}
});
test('stopping during storage preflight cancels the pending start before any capture begins',async()=>{
 const root=mkdtempSync(join(tmpdir(),'at-start-cancel-')),collector=new Collector(root);try{
 let release!:(ok:boolean)=>void;const pending=new Promise<boolean>(resolve=>{release=resolve;});(collector as any).ensureStorageCapacity=()=>pending;const starting=collector.start(30);const rejected=assert.rejects(starting,/cancelled/);assert.equal(collector.status().running,false);await collector.stop();release(true);await rejected;assert.equal(collector.status().running,false);assert.equal(collector.store.events().some(event=>event.kind==='capture_start'),false);
 }finally{await collector.close();rmSync(root,{recursive:true,force:true});}
});
