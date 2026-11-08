import {lstatSync,opendirSync,statfsSync} from 'node:fs';import {join} from 'node:path';
export const FREE_RESERVE_BYTES=1024**3;
export const DEFAULT_STORAGE_LIMIT_MB=5120;
export function storagePolicyDecision(usage:{managedBytes:number;freeBytes:number|null},limitMB:number):'ok'|'care'|'pause'{
 const limit=limitMB*1024*1024;
 if(usage.managedBytes>=limit||usage.freeBytes!==null&&usage.freeBytes<FREE_RESERVE_BYTES)return 'pause';
 if(usage.managedBytes>=limit*.9||usage.freeBytes!==null&&usage.freeBytes<FREE_RESERVE_BYTES*1.5)return 'care';return 'ok';
}
export function quickStorageUsage(root:string):{managedBytes:number;freeBytes:number|null;truncated:boolean}{
 let managedBytes=0,entries=0,truncated=false;const walk=(path:string)=>{
  let info;try{info=lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  if(info.isSymbolicLink())return;if(info.isFile()){managedBytes+=info.size;return;}if(!info.isDirectory())return;
  const dir=opendirSync(path);try{let child;while((child=dir.readSync())){if(++entries>100000){truncated=true;return;}walk(join(path,child.name));if(truncated)return;}}finally{dir.closeSync();}
 };
 for(const name of ['events.sqlite','events.sqlite-wal','events.sqlite-shm','spool','hook-runtime','exports'])walk(join(root,name));
 let freeBytes:number|null=null;try{const fs=statfsSync(root);freeBytes=Number(fs.bavail)*Number(fs.bsize);}catch{/* Capacity unknown: budget still applies. */}
 return {managedBytes,freeBytes,truncated};
}
/** Conservative retained-size estimate; shared references count once, no JSON copy. */
export function estimatedBytes(value:unknown,limit=32*1024*1024):number{
 const seen=new WeakSet<object>();let bytes=0;const visit=(item:unknown,depth:number)=>{
  if(bytes>limit)return;if(typeof item==='string'){bytes+=item.length*2+24;return;}if(item===null||typeof item!=='object'){bytes+=8;return;}
  if(seen.has(item))return;seen.add(item);bytes+=64;if(depth>64){bytes=limit+1;return;}
  if(Array.isArray(item)){bytes+=item.length*8;for(const child of item){visit(child,depth+1);if(bytes>limit)break;}}
  else for(const [key,child] of Object.entries(item)){bytes+=key.length*2+16;visit(child,depth+1);if(bytes>limit)break;}
 };visit(value,0);return bytes;
}
