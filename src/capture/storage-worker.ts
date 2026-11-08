// Long storage operations run here, off the collector's request thread. The
// desktop bridge restarts a collector that leaves a request unanswered too long.
import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';

export type StorageTask=
 {op:'compact';source:string;target:string;options:{idleThreshold?:number;agentIdleThreshold?:number}}|
 {op:'optimize';source:string;target:string}|
 {op:'maintain';database:string;now:number}|
 {op:'export'|'preview'|'restore';database:string;output:string;id?:string}|
 {op:'archives';output:string}|
 {op:'care';database:string;output:string;now:number;archives?:boolean}|
 {op:'import';database:string;output:string;id:string};

export function runStorageTask<T>(task:StorageTask):Promise<T>{
 return new Promise((resolve,reject)=>{
  const worker=new Worker(new URL(import.meta.url),{workerData:task});
  let settled=false;
  worker.once('message',(message:{ok:boolean;result?:T;error?:string})=>{settled=true;if(message.ok)resolve(message.result as T);else reject(new Error(message.error));});
  worker.once('error',error=>{if(!settled){settled=true;reject(error);}});
  worker.once('exit',code=>{if(!settled){settled=true;reject(new Error(`Storage task stopped unexpectedly (${code})`));}});
 });
}

async function perform(task:StorageTask):Promise<unknown>{
 if(task.op==='compact'){const {compactCaptureCopy}=await import('./compact-copy.ts');return compactCaptureCopy(task.source,task.target,task.options);}
 if(task.op==='optimize'){const {optimizedCaptureCopy}=await import('./optimized-copy.ts');return optimizedCaptureCopy(task.source,task.target);}
 if(task.op==='maintain'){const {openEventDatabase}=await import('./event-database.ts');const {packEventHistory}=await import('./packed-maintenance.ts');const db=openEventDatabase(task.database);try{return packEventHistory(db,{now:task.now});}finally{db.close();}}
 if(task.op==='care'){const {openEventDatabase}=await import('./event-database.ts');const {packEventHistory}=await import('./packed-maintenance.ts');const {maintainArchives}=await import('./archive-storage.ts');const {existsSync}=await import('node:fs');const {join}=await import('node:path');if(existsSync(join(task.output,'pending-storage-replacement.json')))return {skipped:true};const db=openEventDatabase(task.database);let packing;try{packing=packEventHistory(db,{now:task.now});db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();}finally{db.close();}return {packing,archives:task.archives?await maintainArchives(task.output):null};}
 if(task.op==='archives'){const {maintainArchives}=await import('./archive-storage.ts');return maintainArchives(task.output);}
 if(task.op==='restore'){const {prepareRestoreAsync}=await import('./storage-migration.ts');return prepareRestoreAsync(task.output,task.id!);}
 const {EventStore}=await import('./store.ts');
 const store=new EventStore(task.database);
 try{if(task.op==='export')return await store.exportArchiveCompressed(task.output);if(task.op==='preview')return await store.previewArchiveAsync(task.output,task.id!);return await store.importArchiveAsync(task.output,task.id!);}finally{store.close();}
}

if(!isMainThread&&parentPort&&workerData&&typeof workerData==='object'&&'op' in workerData){
 const port=parentPort;
 perform(workerData as StorageTask).then(
  result=>port.postMessage({ok:true,result}),
  error=>port.postMessage({ok:false,error:error instanceof Error?error.message:String(error)}),
 );
}
