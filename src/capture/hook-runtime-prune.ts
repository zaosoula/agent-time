import {execFileSync} from 'node:child_process';
import {lstatSync,readdirSync} from 'node:fs';
import {rm} from 'node:fs/promises';
import {join} from 'node:path';

const runtimeName=/^[a-f0-9]{16}(?:-replaced-[a-f0-9-]+)?$/;
const currentName=/^[a-f0-9]{16}$/;
const allowedFiles=new Set(['node','hook-runner.ts','hooks.ts','events.ts','store.ts','observation-retention.ts','orca.ts','orca-focus.ts','package.json','sources']);
const graceMs=60*60*1000;

function recognizedRuntime(path:string):boolean{
 try{
  const stat=lstatSync(path);
  if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid?.())return false;
  const names=readdirSync(path);
  if(!names.includes('node')||!names.includes('hook-runner.ts')||!names.includes('package.json')||!names.includes('sources')||names.some(name=>!allowedFiles.has(name)))return false;
  for(const name of names){
   const entry=lstatSync(join(path,name));
   if(entry.isSymbolicLink())return false;
   if(name==='sources'){
    if(!entry.isDirectory())return false;
    for(const source of readdirSync(join(path,name))){
     if(!/^(?:[a-z0-9-]+\.agent\.ts|agent-registry\.ts|types\.ts)$/.test(source)||!lstatSync(join(path,name,source)).isFile())return false;
    }
   }else if(!entry.isFile())return false;
  }
  return true;
 }catch{return false;}
}

/** Remove only old generated copies after the current launcher has been verified. */
export async function pruneHookRuntimes(root:string,current:string,options:{now?:number;activeCommands?:string}={}):Promise<number>{
 if(!currentName.test(current))return 0;
 try{const stat=lstatSync(root);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid?.())return 0;}catch{return 0;}
 if(!recognizedRuntime(join(root,current)))return 0;
 let commands=options.activeCommands;
 if(commands===undefined)try{commands=execFileSync('/bin/ps',['-axo','command'],{encoding:'utf8',maxBuffer:8*1024*1024});}catch{return 0;}
 const copies=readdirSync(root,{withFileTypes:true}).filter(entry=>entry.isDirectory()&&runtimeName.test(entry.name))
  .map(entry=>({name:entry.name,path:join(root,entry.name)})).filter(entry=>recognizedRuntime(entry.path))
  .map(entry=>({...entry,mtime:lstatSync(entry.path).mtimeMs})).sort((a,b)=>b.mtime-a.mtime);
 const previous=copies.find(copy=>copy.name!==current)?.name;
 let removed=0;
 for(const copy of copies){
  if(copy.name===current||copy.name===previous||(options.now??Date.now())-copy.mtime<graceMs||commands.includes(copy.path))continue;
  if(!recognizedRuntime(copy.path)||lstatSync(copy.path).mtimeMs!==copy.mtime)continue;
  try{await rm(copy.path,{recursive:true});removed++;}catch{/* A busy or changed runtime stays for the next pass. */}
 }
 return removed;
}
