import {DatabaseSync} from 'node:sqlite';
import {lstatSync,readdirSync} from 'node:fs';
import {join} from 'node:path';

export interface StorageSize {bytes:number;files:number;truncated:boolean;}
export interface StorageUsage {
 database:StorageSize;wal:StorageSize;sharedMemory:StorageSize;indexes:StorageSize;
 spool:StorageSize;runtimes:StorageSize;exports:StorageSize;
 totalBytes:number;eventCount:number;
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
  let entries;
  try{entries=readdirSync(next,{withFileTypes:true});}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
  for(const entry of entries){
   if(++visited>maxEntries){result.truncated=true;return result;}
   if(entry.isSymbolicLink())continue;
   const child=join(next,entry.name);
   if(entry.isDirectory())stack.push(child);
   else if(entry.isFile()){const size=fileSize(child);result.bytes+=size.bytes;result.files+=size.files;}
  }
 }
 return result;
}
export function storageUsage(root:string,now=Date.now()/1000):StorageUsage{
 const database=fileSize(join(root,'events.sqlite')),wal=fileSize(join(root,'events.sqlite-wal'));
 const sharedMemory=fileSize(join(root,'events.sqlite-shm'));
 const spool=directorySize(join(root,'spool')),runtimes=directorySize(join(root,'hook-runtime'));
 const exports=directorySize(join(root,'exports'));
 const indexes=empty();
 let eventCount=0;
 let byDay:StorageUsage['byDay']=[];
 if(database.files){
  const db=new DatabaseSync(join(root,'events.sqlite'),{readOnly:true});
  try{
   eventCount=Number(db.prepare('SELECT count(*) count FROM events').get()?.count||0);
   indexes.bytes=Number(db.prepare("SELECT coalesce(sum(pgsize),0) bytes FROM dbstat WHERE name IN (SELECT name FROM sqlite_master WHERE type='index')").get()?.bytes||0);
   const cutoff=now-30*86400;
   byDay=db.prepare("SELECT date(observed_at,'unixepoch','localtime') date,json_extract(payload,'$.source') source,count(*) events,sum(length(payload)) payloadBytes FROM events WHERE observed_at>=? AND observed_at<=? GROUP BY 1,2 ORDER BY 1 DESC,2").all(cutoff,now)
    .map(row=>({date:String(row.date),source:String(row.source),events:Number(row.events),payloadBytes:Number(row.payloadBytes)}));
  }finally{db.close();}
 }
 return {database,wal,sharedMemory,indexes,spool,runtimes,exports,eventCount,byDay,
  totalBytes:database.bytes+wal.bytes+sharedMemory.bytes+spool.bytes+runtimes.bytes+exports.bytes};
}
