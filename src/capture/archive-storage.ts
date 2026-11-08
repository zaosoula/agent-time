import {createHash,randomUUID} from 'node:crypto';
import {createReadStream,createWriteStream,existsSync,lstatSync,mkdtempSync,mkdirSync,readFileSync,renameSync,linkSync,rmSync,statfsSync,writeFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {createGzip,createGunzip} from 'node:zlib';import {Transform,Writable} from 'node:stream';import {pipeline} from 'node:stream/promises';
export const archiveName=/^agent-time-[0-9TZ-]+-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.sqlite(?:\.gz)?$/;
const regular=(path:string)=>{const info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink())throw new Error('Archive must be a regular file');return info;};
const same=(a:NonNullable<ReturnType<typeof lstatSync>>,b:NonNullable<ReturnType<typeof lstatSync>>)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs;
async function fileHash(path:string){const hash=createHash('sha256');let bytes=0;for await(const data of createReadStream(path)){hash.update(data);bytes+=data.length;}return {hash:hash.digest('hex'),bytes};}
export async function compressArchive(path:string):Promise<{path:string;bytes:number;sha256:string;originalBytes:number}>{
 const before=regular(path),target=path+'.gz',temp=target+'.'+randomUUID()+'.tmp';
 if(existsSync(target))throw new Error('Compressed archive already exists');
 if(path.endsWith('.gz')||existsSync(path+'-wal')&&regular(path+'-wal').size>0)throw new Error('Archive is not a closed database copy');
 const hash=createHash('sha256');let bytes=0;
 try{
  await pipeline(createReadStream(path),new Transform({transform(chunk,_encoding,next){hash.update(chunk);bytes+=chunk.length;next(null,chunk);}}),createGzip({level:6}),createWriteStream(temp,{flags:'wx',mode:0o600}));
  const originalHash=hash.digest('hex'),verified=createHash('sha256');let restored=0;
  await pipeline(createReadStream(temp),createGunzip(),new Writable({write(chunk,_encoding,next){restored+=chunk.length;if(restored>before.size){next(new Error('Archive verification exceeded original size'));return;}verified.update(chunk);next();}}));
  if(restored!==bytes||bytes!==before.size||verified.digest('hex')!==originalHash)throw new Error('Compressed archive verification failed');
  const current=await fileHash(path);if(!same(before,regular(path))||current.hash!==originalHash||current.bytes!==bytes)throw new Error('Archive changed during compression');
  if(existsSync(target))throw new Error('Compressed archive already exists');
  linkSync(temp,target);rmSync(temp);
  // Publishing precedes removing the redundant exact-byte original.
  if(!same(before,regular(path)))throw new Error('Archive changed before cleanup');
  rmSync(path);return {path:target,bytes:regular(target).size,sha256:originalHash,originalBytes:bytes};
 }finally{rmSync(temp,{force:true});}
}
export async function withReadableArchive<T>(path:string,run:(plainPath:string)=>T|Promise<T>):Promise<T>{
 regular(path);if(!path.endsWith('.gz'))return await run(path);
 const folder=mkdtempSync(join(tmpdir(),'agent-time-archive-')),plain=join(folder,'archive.sqlite');
 try{
  const disk=statfsSync(folder),limit=Math.max(0,Number(disk.bavail)*Number(disk.bsize)-1024*1024*1024);let bytes=0;
  await pipeline(createReadStream(path),createGunzip(),new Transform({transform(chunk,_encoding,next){bytes+=chunk.length;next(bytes>limit?new Error('Not enough free space to read this archive'):null,chunk);}}),createWriteStream(plain,{flags:'wx',mode:0o600}));
  return await run(plain);
 }finally{rmSync(folder,{recursive:true,force:true});}
}
type Provenance=Record<string,'manual'|'rollback'>;
function provenance(root:string):Provenance{
 try{const value:unknown=JSON.parse(readFileSync(join(root,'exports','archive-provenance.json'),'utf8'));if(!value||typeof value!=='object'||Array.isArray(value))return {};return Object.fromEntries(Object.entries(value).filter(([id,kind])=>archiveName.test(id)&&!id.endsWith('.gz')&&(kind==='manual'||kind==='rollback'))) as Provenance;}catch{return {};}
}
export function recordArchive(root:string,id:string,kind:'manual'|'rollback'):void{
 if(!archiveName.test(id))throw new Error('Invalid archive name');
 const folder=join(root,'exports');mkdirSync(folder,{recursive:true,mode:0o700});if(lstatSync(folder).isSymbolicLink())throw new Error('Archive folder must not be a symlink');
 const entries=provenance(root);entries[id.replace(/\.gz$/,'')]=kind;
 const path=join(folder,'archive-provenance.json'),temp=path+'.'+randomUUID()+'.tmp';try{writeFileSync(temp,JSON.stringify(entries),{flag:'wx',mode:0o600});renameSync(temp,path);}finally{rmSync(temp,{force:true});}
}
export interface ArchiveCareResult {savedBytes:number;removed:string[];protected:string[];}
export async function maintainArchives(root:string,options:{maxAutomatic?:number;maxAutomaticBytes?:number;covered?:(id:string)=>Promise<boolean>}={}):Promise<ArchiveCareResult>{
 const result:ArchiveCareResult={savedBytes:0,removed:[],protected:[]},folder=join(root,'exports');if(!existsSync(folder))return result;
 if(lstatSync(folder).isSymbolicLink())throw new Error('Archive folder must not be a symlink');
 const excluded=new Set<string>();const pending=join(root,'pending-storage-replacement.json');
 if(existsSync(pending)){const value=JSON.parse(readFileSync(pending,'utf8'));for(const id of [value.candidate,value.backup])if(typeof id==='string')excluded.add(id);}
 const entries=provenance(root),files=readdirSync(folder).filter(id=>archiveName.test(id)&&!excluded.has(id)).sort().reverse();
 for(const id of files){const path=join(folder,id);regular(path);if(!id.endsWith('.gz')){try{const compressed=await compressArchive(path);result.savedBytes+=compressed.originalBytes-compressed.bytes;}catch(error){if(!existsSync(path+'.gz'))throw error;result.protected.push(id);}}}
 const automatic=readdirSync(folder).filter(id=>archiveName.test(id)&&id.endsWith('.gz')&&entries[id.slice(0,-3)]==='rollback'&&!excluded.has(id.slice(0,-3))).sort().reverse();
 let total=automatic.reduce((n,id)=>n+regular(join(folder,id)).size,0),remaining=automatic.length;
 const maxCount=Math.max(1,options.maxAutomatic??2),maxBytes=options.maxAutomaticBytes??512*1024*1024;
 let store:import('./store.ts').EventStore|undefined;
 try{
  const covered=options.covered??(async(id:string)=>{store??=new (await import('./store.ts')).EventStore(join(root,'events.sqlite'));const preview=await store.previewArchiveAsync(root,id);return Object.entries(preview).every(([key,value])=>key==='id'||key==='archiveEvents'||value===0);});
  // The newest rollback remains even when it alone exceeds the target.
  for(const id of automatic.slice(1).reverse()){
   if(remaining<=maxCount&&total<=maxBytes)break;
   let safe=false;try{safe=await covered(id);}catch{/* Unverified copies are protected. */}
   if(!safe){result.protected.push(id);continue;}
   const path=join(folder,id),size=regular(path).size;rmSync(path);result.removed.push(id);result.savedBytes+=size;remaining--;total-=size;
  }
 }finally{store?.close();}
 return result;
}
