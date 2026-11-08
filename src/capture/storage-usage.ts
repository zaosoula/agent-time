import {openEventDatabase,isPackedEventDatabase,eventStorageStats} from './event-database.ts';
import {DatabaseSync} from 'node:sqlite';
import {lstatSync,opendirSync,statfsSync} from 'node:fs';
import {join} from 'node:path';

export interface StorageSize {bytes:number;files:number;truncated:boolean;}
export interface StorageUsage {
 database:StorageSize;wal:StorageSize;sharedMemory:StorageSize;indexes:StorageSize;
 spool:StorageSize;runtimes:StorageSize;exports:StorageSize;
 history?:ReturnType<typeof eventStorageStats>&{efficient:boolean};storageLimitMB?:number;care?:{at:number|null;error:string|null;paused:boolean};
 totalBytes:number;eventCount:number;freeBytes:number|null;
 byDay:Array<{date:string;source:string;events:number;payloadBytes:number}>;
}
const empty=():StorageSize=>({bytes:0,files:0,truncated:false});
function fileSize(path:string):StorageSize{
 try{const item=lstatSync(path);return item.isFile()?{bytes:item.size,files:1,truncated:false}:empty();}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return empty();throw error;}
}
function directorySize(path:string,maxEntries=100_000):StorageSize{
 const result=empty(),stack=[path];let visited=0;
 while(stack.length){
  const next=stack.pop()!;
  let directory;
  try{directory=opendirSync(next);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
  try{let entry;while((entry=directory.readSync())){
   if(++visited>maxEntries){result.truncated=true;return result;}
   if(entry.isSymbolicLink())continue;
   const child=join(next,entry.name);
   if(entry.isDirectory())stack.push(child);
   else if(entry.isFile()){const size=fileSize(child);result.bytes+=size.bytes;result.files+=size.files;}
  }}finally{directory.closeSync();}
 }
 return result;
}
export function storageUsage(root:string,now=Date.now()/1000):StorageUsage{
 const database=fileSize(join(root,'events.sqlite')),wal=fileSize(join(root,'events.sqlite-wal'));
 const sharedMemory=fileSize(join(root,'events.sqlite-shm'));
 const spool=directorySize(join(root,'spool')),runtimes=directorySize(join(root,'hook-runtime'));
 const exports=directorySize(join(root,'exports'));
 const indexes=empty();
 let freeBytes:number|null=null;
 try{const volume=statfsSync(root);freeBytes=Number(volume.bavail)*Number(volume.bsize);}catch{/* Report storage even when filesystem capacity is unavailable. */}
 let eventCount=0,history:StorageUsage['history'];
 let byDay:StorageUsage['byDay']=[];
 if(database.files){
  const db=openEventDatabase(join(root,'events.sqlite'),{readOnly:true});
  try{
   history={...eventStorageStats(db),efficient:isPackedEventDatabase(db)};
   eventCount=Number(db.prepare('SELECT count(*) count FROM events').get()?.count||0);
   indexes.bytes=Number(db.prepare("SELECT coalesce(sum(pgsize),0) bytes FROM dbstat WHERE name IN (SELECT name FROM sqlite_master WHERE type='index')").get()?.bytes||0);
   const cutoff=now-30*86400;
   const payloadSize=isPackedEventDatabase(db)?'payload_bytes':'length(payload)',source=isPackedEventDatabase(db)?'source':"json_extract(payload,'$.source')";
   byDay=db.prepare(`SELECT date(observed_at,'unixepoch','localtime') date,${source} source,count(*) events,sum(${payloadSize}) payloadBytes FROM events WHERE observed_at>=? AND observed_at<=? GROUP BY 1,2 ORDER BY 1 DESC,2`).all(cutoff,now)
    .map(row=>({date:String(row.date),source:String(row.source),events:Number(row.events),payloadBytes:Number(row.payloadBytes)}));
  }finally{db.close();}
 }
 return {database,wal,sharedMemory,indexes,spool,runtimes,exports,eventCount,byDay,freeBytes,history,
  totalBytes:database.bytes+wal.bytes+sharedMemory.bytes+spool.bytes+runtimes.bytes+exports.bytes};
}
