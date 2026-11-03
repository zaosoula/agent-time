import {execFileSync} from 'node:child_process';
import {existsSync,lstatSync,readFileSync,statSync,unlinkSync,writeFileSync} from 'node:fs';

// The capture lock names its owner by PID and process start time. A bare PID is
// reused after a reboot, and would otherwise block capture with a stale lock.
export interface LockOwner {pid:number;started:string|null;}

export function processStartTime(pid:number):string|null{
 if(!Number.isInteger(pid)||pid<1)return null;
 try{
  const value=execFileSync('/bin/ps',['-o','lstart=','-p',String(pid)],{encoding:'utf8',timeout:2000,env:{...process.env,LC_ALL:'C'},stdio:['ignore','pipe','ignore']}).trim();
  return value||null;
 }catch{return null;}
}
let ownStart:string|null|undefined;
function currentStart(){if(ownStart===undefined)ownStart=processStartTime(process.pid);return ownStart;}

export function parseLock(text:string):LockOwner|null{
 const raw=text.trim();
 if(/^\d+$/.test(raw)){const pid=Number(raw);return Number.isSafeInteger(pid)&&pid>0?{pid,started:null}:null;}
 try{
  const value=JSON.parse(raw) as Partial<LockOwner>;
  if(!Number.isSafeInteger(value.pid)||value.pid!<1||value.started!==null&&value.started!==undefined&&typeof value.started!=='string')return null;
  return {pid:value.pid!,started:value.started??null};
 }catch{return null;}
}
export function lockText():string{return JSON.stringify({pid:process.pid,started:currentStart()});}
export function writeLock(path:string):void{writeFileSync(path,lockText(),{mode:0o600,flag:'wx'});}
export function ownsLock(path:string):boolean{
 try{return parseLock(readFileSync(path,'utf8'))?.pid===process.pid;}catch{return false;}
}
function alive(pid:number):boolean{
 try{process.kill(pid,0);return true;}
 catch(error){
  // EPERM: the process exists but belongs to another user.
  if((error as NodeJS.ErrnoException).code==='EPERM')return true;
  if((error as NodeJS.ErrnoException).code==='ESRCH')return false;
  throw error;
 }
}
/**
 * Whether the lock names a live process that could own it. Stale locks from a
 * reused PID are recognized by start time: recorded for current locks, and for
 * legacy bare-PID locks by a process that started after the lock was written.
 */
export function lockOwnerAlive(path:string,owner:LockOwner,startOf:(pid:number)=>string|null=processStartTime):boolean{
 if(owner.pid===process.pid)return true;
 if(!alive(owner.pid))return false;
 const started=startOf(owner.pid);
 if(!started)return true;
 if(owner.started)return owner.started===started;
 const startedAt=Date.parse(started);
 if(!Number.isFinite(startedAt))return true;
 let writtenAt:number;try{writtenAt=statSync(path).mtimeMs;}catch{return true;}
 // lstart has one-second resolution; allow a little skew before calling it reused.
 return startedAt<=writtenAt+2000;
}
/** Remove a stale lock, or throw when a live collector owns the directory. */
export function clearStaleLock(path:string,messages:{unreadable:string;live:string},startOf?:(pid:number)=>string|null):void{
 if(!existsSync(path))return;
 const info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink())throw new Error(messages.unreadable);
 const owner=parseLock(readFileSync(path,'utf8'));
 if(!owner)throw new Error(messages.unreadable);
 if(lockOwnerAlive(path,owner,startOf))throw new Error(messages.live);
 unlinkSync(path);
}
