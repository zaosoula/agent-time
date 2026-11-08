// Long storage operations run here, off the collector's request thread. The
// desktop bridge restarts a collector that leaves a request unanswered too long.
import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';

export type StorageTask=
 {op:'compact';source:string;target:string;options:{idleThreshold?:number;agentIdleThreshold?:number}}|
 {op:'optimize';source:string;target:string}|
 {op:'maintain';database:string;now:number}|
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
 const {EventStore}=await import('./store.ts');
 const store=new EventStore(task.database);
 try{return store.importArchive(task.output,task.id);}finally{store.close();}
}

if(!isMainThread&&parentPort&&workerData&&typeof workerData==='object'&&'op' in workerData){
 const port=parentPort;
 perform(workerData as StorageTask).then(
  result=>port.postMessage({ok:true,result}),
  error=>port.postMessage({ok:false,error:error instanceof Error?error.message:String(error)}),
 );
}
