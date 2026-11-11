import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {openEventDatabase,isPackedEventDatabase} from './event-database.ts';
import {packEventHistory} from './packed-maintenance.ts';
import {quickStorageUsage,FREE_RESERVE_BYTES} from './storage-policy.ts';
export const PRESSURE_HEADROOM_BYTES=160*1024**2;
export interface PressureRecoveryResult {packedEvents:number;originalBytes:number;compressedBytes:number;reason:'recovered'|'headroom'|'replacement'|'legacy'|'preparation'|'readers'|'exhausted'|'bounded';}
/** Runs off the request thread. No full copy, schema upgrade, or history deletion. */
export function compressHistoryUnderPressure(database:string,output:string,now:number,options:{readUsage?:typeof quickStorageUsage;maxBatches?:number;budgetMs?:number}={}):PressureRecoveryResult{
 const usage=()=> (options.readUsage??quickStorageUsage)(output);
 const result:PressureRecoveryResult={packedEvents:0,originalBytes:0,compressedBytes:0,reason:'bounded'};
 if(existsSync(join(output,'pending-storage-replacement.json')))return {...result,reason:'replacement'};
 const initial=usage();
 if(initial.freeBytes!==null&&initial.freeBytes>=FREE_RESERVE_BYTES)return {...result,reason:'recovered'};
 if(initial.truncated||initial.freeBytes===null||initial.freeBytes<PRESSURE_HEADROOM_BYTES)return {...result,reason:'headroom'};
 const db=openEventDatabase(database),started=Date.now(),limit=Math.max(1,Math.min(64,options.maxBatches??64)),budget=Math.max(1,Math.min(60000,options.budgetMs??60000));
 try{
  if(!isPackedEventDatabase(db))return {...result,reason:'legacy'};
  // Building this index for the first time can require a database-sized sort
  // and WAL. Leave that preparation to ordinary care with ample free space.
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='at_events_hot'").get())return {...result,reason:'preparation'};
  for(let batch=0;batch<limit&&Date.now()-started<budget;batch++){
   if(existsSync(join(output,'pending-storage-replacement.json'))){result.reason='replacement';break;}
   const before=usage();
   if(before.freeBytes!==null&&before.freeBytes>=FREE_RESERVE_BYTES){result.reason='recovered';break;}
   if(before.truncated||before.freeBytes===null||before.freeBytes<PRESSURE_HEADROOM_BYTES){result.reason='headroom';break;}
   const packed=packEventHistory(db,{now,hotDays:0,hotBytes:0,maxRows:4096,maxBytes:4*1024**2});
   result.packedEvents+=packed.packedEvents;result.originalBytes+=packed.originalBytes;result.compressedBytes+=packed.compressedBytes;
   db.exec('PRAGMA incremental_vacuum(2048)');
   const checkpoint=db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
   const after=usage();
   if(after.freeBytes!==null&&after.freeBytes>=FREE_RESERVE_BYTES){result.reason='recovered';break;}
   if(Number(checkpoint?.busy)>0){result.reason='readers';break;}
   if(!packed.packedEvents){result.reason='exhausted';break;}
  }
  return result;
 }finally{db.close();}
}
