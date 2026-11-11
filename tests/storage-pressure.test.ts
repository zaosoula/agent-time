import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventStore} from '../src/capture/store.ts';
import {makeEvent} from '../src/capture/events.ts';
import {eventsDigest} from '../src/capture/compact-verification.ts';
import {eventStorageStats} from '../src/capture/event-database.ts';
import {quickStorageUsage} from '../src/capture/storage-policy.ts';
import {Collector} from '../src/capture/collector.ts';
import {indexToolBoundaries} from '../src/capture/packed-maintenance.ts';
const GiB=1024**3;

test('emergency compression packs recent history in bounded batches without changing evidence or decisions',async()=>{
 const {compressHistoryUnderPressure}=await import('../src/capture/storage-pressure.ts');
 const root=mkdtempSync(join(tmpdir(),'at-pressure-pack-')),path=join(root,'events.sqlite'),store=new EventStore(path);
 try{
  for(let i=0;i<5000;i++)store.put(makeEvent('macos','activity',{eventId:String(i),observedAt:1000+i,monotonicAt:i,data:{idleSeconds:0,context:'repeat'.repeat(220)}}));
  store.setHumanDecisions([['0','1']],'assigned','/project');
  indexToolBoundaries(store.database,1);
  const digest=eventsDigest(store.database),decisions=store.humanDecisions();
  const result=compressHistoryUnderPressure(path,root,6000,{maxBatches:1,readUsage:()=>({...quickStorageUsage(root),freeBytes:GiB/2})});
  assert.ok(result.packedEvents>0&&result.packedEvents<=4096);assert.ok(result.originalBytes<=4*1024**2);
  assert.ok(eventStorageStats(store.database).hotEvents>0);assert.equal(eventsDigest(store.database),digest);assert.deepEqual(store.humanDecisions(),decisions);
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
test('emergency compression stops when headroom is too low or a replacement is pending',async()=>{
 const {compressHistoryUnderPressure}=await import('../src/capture/storage-pressure.ts');
 const root=mkdtempSync(join(tmpdir(),'at-pressure-headroom-')),path=join(root,'events.sqlite'),store=new EventStore(path);
 try{
  store.put(makeEvent('macos','activity',{data:{idleSeconds:0}}));const before=eventsDigest(store.database);
  const low=()=>({...quickStorageUsage(root),freeBytes:32*1024**2});
  assert.equal(compressHistoryUnderPressure(path,root,1e10,{readUsage:low}).reason,'headroom');
  writeFileSync(join(root,'pending-storage-replacement.json'),'{}');
  assert.equal(compressHistoryUnderPressure(path,root,1e10,{readUsage:()=>({...quickStorageUsage(root),freeBytes:GiB/2})}).reason,'replacement');
  assert.equal(eventsDigest(store.database),before);assert.equal(eventStorageStats(store.database).coldEvents,0);
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
test('emergency compression never builds a missing whole-history index under low disk pressure',async()=>{
 const {compressHistoryUnderPressure}=await import('../src/capture/storage-pressure.ts');
 const root=mkdtempSync(join(tmpdir(),'at-pressure-index-')),path=join(root,'events.sqlite'),store=new EventStore(path);
 try{
  store.put(makeEvent('macos','activity',{data:{idleSeconds:0}}));const before=eventsDigest(store.database);
  assert.equal(compressHistoryUnderPressure(path,root,1e10,{readUsage:()=>({...quickStorageUsage(root),freeBytes:GiB/2})}).reason,'preparation');
  assert.equal(store.database.prepare("SELECT 1 FROM sqlite_master WHERE name='at_events_hot'").get(),undefined);
  assert.equal(eventsDigest(store.database),before);
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
test('an unwritable pause marker cannot hide a low-disk pause or its notification state',async()=>{
 const root=mkdtempSync(join(tmpdir(),'at-pressure-marker-')),collector=new Collector(root);
 try{
  collector.updateSettings({macosActivity:false,orcaPolling:false,tokenUsage:false});mkdirSync(join(root,'storage-paused.json.tmp'));
  (collector as any).readStorageUsage=()=>({...quickStorageUsage(root),freeBytes:0});
  (collector as any).runPressureCompression=async()=>({packedEvents:0,originalBytes:0,compressedBytes:0,reason:'headroom'});
  await assert.rejects(collector.start(),/1 GB/);await (collector as any).pressureRecovery;
  assert.equal(existsSync(join(root,'storage-paused.json')),false);
  assert.equal(collector.status().storageCare.paused,true);assert.equal(collector.trayStatus().storageCare.pressure?.phase,'blocked');
 }finally{await collector.close();rmSync(root,{recursive:true,force:true});}
});
test('low disk pauses first, holds ownership during automatic compression, and requires safe manual resume',async()=>{
 const root=mkdtempSync(join(tmpdir(),'at-pressure-lifecycle-')),collector=new Collector(root);let release!:(value:unknown)=>void;
 const pending=new Promise(resolve=>{release=resolve;});
 try{
  collector.updateSettings({macosActivity:false,orcaPolling:false,tokenUsage:false});
  (collector as any).readStorageUsage=()=>({...quickStorageUsage(root),freeBytes:GiB/2});
  (collector as any).runPressureCompression=()=>{
   assert.equal(collector.status().running,false);assert.ok(existsSync(join(root,'storage-paused.json')));assert.ok(existsSync(join(root,'capture.lock')));return pending;
  };
  await assert.rejects(collector.start(),/disk space|1 GB/);
  assert.equal(collector.status().storageCare.pressure?.phase,'compressing');
  const recovery=(collector as any).pressureRecovery;
  await collector.stop();assert.ok(existsSync(join(root,'capture.lock')));
  await assert.rejects(collector.start(),/storage|compression/);
  const other=new Collector(root);
  try{await assert.rejects(other.start(),/Another collector/);}finally{await other.close();}
  release({packedEvents:1,originalBytes:10,compressedBytes:2,reason:'exhausted'});await recovery;
  assert.equal(collector.status().running,false);assert.equal(collector.status().storageCare.pressure?.phase,'blocked');
  assert.equal(existsSync(join(root,'capture.lock')),false);assert.equal(existsSync(join(root,'storage-paused.json')),true);
  (collector as any).readStorageUsage=()=>({...quickStorageUsage(root),freeBytes:2*GiB});
  await collector.start();assert.equal(collector.status().running,true);assert.equal(existsSync(join(root,'storage-paused.json')),false);
 }finally{release?.({packedEvents:0,originalBytes:0,compressedBytes:0,reason:'exhausted'});await collector.close();rmSync(root,{recursive:true,force:true});}
});

test('interrupted recovery is reported as failed and a saved ready notice is checked against current capacity',async()=>{
 const root=mkdtempSync(join(tmpdir(),'at-pressure-restart-'));
 const pressure={id:'interrupted',reason:'disk-space',phase:'compressing',at:1000,freeBytes:GiB/2,savedBytes:0};
 let collector:Collector|undefined;
 try{
  writeFileSync(join(root,'storage-paused.json'),JSON.stringify({pressure}));
  collector=new Collector(root);
  assert.equal(collector.status().storageCare.pressure?.phase,'failed');await collector.close();collector=undefined;
  writeFileSync(join(root,'storage-paused.json'),JSON.stringify({pressure:{...pressure,phase:'ready'}}));
  collector=new Collector(root);(collector as any).careState.pressure=undefined;(collector as any).readStorageUsage=()=>({...quickStorageUsage(root),freeBytes:GiB/2});
  assert.equal(collector.status().storageCare.pressure?.phase,'blocked');
 }finally{await collector?.close();rmSync(root,{recursive:true,force:true});}
});

test('successful recovery automatically resumes capture only after current capacity is safe',async()=>{
 const root=mkdtempSync(join(tmpdir(),'at-pressure-ready-')),collector=new Collector(root);let free=GiB/2;
 try{
  collector.updateSettings({macosActivity:false,orcaPolling:false,tokenUsage:false});
  (collector as any).readStorageUsage=()=>({...quickStorageUsage(root),freeBytes:free});
  (collector as any).runPressureCompression=async()=>{free=2*GiB;return {packedEvents:0,originalBytes:0,compressedBytes:0,reason:'recovered'};};
  await assert.rejects(collector.start(),/1 GB/);await (collector as any).pressureRecovery;
  assert.equal(collector.status().storageCare.pressure?.phase,'ready');assert.equal(collector.status().running,false);
  await (collector as any).resumeAfterStorage();assert.equal(collector.status().running,true);assert.equal(collector.status().storageCare.paused,false);
  assert.equal(collector.status().storageCare.pressure?.phase,'resumed');
  await (collector as any).ensureStorageCapacity();assert.equal(collector.trayStatus().storageCare.pressure?.phase,'resumed');
 }finally{await collector.close();rmSync(root,{recursive:true,force:true});}
});

test('storage pause probes restart after space is freed later, survive relaunch, and leave manual pauses alone',async()=>{
 const root=mkdtempSync(join(tmpdir(),'at-pressure-probe-'));let collector=new Collector(root),free:number|null=GiB/2;
 const usage=()=>({...quickStorageUsage(root),freeBytes:free});
 try{
  collector.updateSettings({macosActivity:false,orcaPolling:false,tokenUsage:false});
  (collector as any).readStorageUsage=usage;
  (collector as any).runPressureCompression=async()=>({packedEvents:0,originalBytes:0,compressedBytes:0,reason:'exhausted'});
  await assert.rejects(collector.start(),/1 GB/);await (collector as any).pressureRecovery;
  await (collector as any).resumeAfterStorage();assert.equal(collector.status().running,false);
  await collector.close();collector=new Collector(root);(collector as any).readStorageUsage=usage;
  assert.equal(collector.status().storageCare.pressure?.autoResume,true);
  free=null;await (collector as any).resumeAfterStorage();assert.equal(collector.status().running,false);
  free=GiB;await (collector as any).resumeAfterStorage();assert.equal(collector.status().running,false);
  free=2*GiB;await (collector as any).resumeAfterStorage();assert.equal(collector.status().running,true);
  await collector.stop();await (collector as any).resumeAfterStorage();assert.equal(collector.status().running,false);
 }finally{await collector.close();rmSync(root,{recursive:true,force:true});}
});

test('a live low-disk stop records its timing boundary before compression and preserves recovery state across ordinary care',async()=>{
 const root=mkdtempSync(join(tmpdir(),'at-pressure-live-')),collector=new Collector(root);
 try{
  collector.updateSettings({macosActivity:false,orcaPolling:false,tokenUsage:false});await collector.start();
  const ordinary=(collector as any).performStorageCare();
  (collector as any).readStorageUsage=()=>({...quickStorageUsage(root),freeBytes:GiB/2});
  (collector as any).runPressureCompression=async()=>{
   assert.equal(collector.status().running,false);assert.equal(collector.store.events().at(-1)?.kind,'capture_stop');
   return {packedEvents:0,originalBytes:0,compressedBytes:0,reason:'exhausted'};
  };
  (collector as any).nextStorageCheck=0;await (collector as any).tick();await ordinary;await (collector as any).pressureRecovery;
  const pressure=collector.status().storageCare.pressure;
  assert.equal(pressure?.phase,'blocked');assert.ok(pressure?.id);assert.equal(pressure?.reason,'disk-space');
  assert.equal(collector.store.events().filter(e=>e.kind==='capture_stop').length,1);
 }finally{await collector.close();rmSync(root,{recursive:true,force:true});}
});
test('failed automatic compression keeps capture paused, releases ownership and preserves history',async()=>{
 const root=mkdtempSync(join(tmpdir(),'at-pressure-failure-')),collector=new Collector(root);
 try{
  collector.updateSettings({macosActivity:false,orcaPolling:false,tokenUsage:false});
  const before=collector.store.events();
  (collector as any).readStorageUsage=()=>({...quickStorageUsage(root),freeBytes:GiB/2});
  (collector as any).runPressureCompression=async()=>{throw new Error('injected compression failure');};
  await assert.rejects(collector.start(),/1 GB/);await (collector as any).pressureRecovery;
  assert.equal(collector.status().storageCare.pressure?.phase,'failed');assert.equal(collector.status().running,false);
  assert.ok(existsSync(join(root,'storage-paused.json')));assert.equal(existsSync(join(root,'capture.lock')),false);
  assert.deepEqual(collector.store.events(),before);
 }finally{await collector.close();rmSync(root,{recursive:true,force:true});}
});
