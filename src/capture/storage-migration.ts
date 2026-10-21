import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {chmodSync,closeSync,existsSync,lstatSync,mkdirSync,openSync,readFileSync,readSync,renameSync,rmSync,statfsSync,statSync,unlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {compactCaptureCopy,type CompactCopyResult} from './compact-copy.ts';
import {validateEvent,type CaptureEvent} from './events.ts';

const namePattern=/^agent-time-[0-9TZ-]+-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.sqlite$/;
const digestPattern=/^[a-f0-9]{64}$/;
const markerName='pending-storage-replacement.json';
const resultName='last-storage-replacement.json';
interface PendingReplacement {candidate:string;backup:string;sourceHash:string;candidateHash:string;kind:'compaction'|'restore';}
export interface ReplacementResult {status:'applied'|'stale';kind:'compaction'|'restore';backup:string;at:string;}
export interface PreparedCompaction extends CompactCopyResult {candidate:string;backup:string;savingsBytes:number;}
function hash(path:string){
 const digest=createHash('sha256'),fd=openSync(path,'r'),chunk=Buffer.allocUnsafe(1024*1024);
 try{let bytes:number;while((bytes=readSync(fd,chunk,0,chunk.length,null))>0)digest.update(chunk.subarray(0,bytes));}
 finally{closeSync(fd);}
 return digest.digest('hex');
}
const named=()=>`agent-time-${new Date().toISOString().replaceAll(/[:.]/g,'-')}-${randomUUID()}.sqlite`;
function regular(path:string){const item=lstatSync(path);if(!item.isFile()||item.isSymbolicLink())throw new Error('Storage file must be a regular file');}
function folder(root:string){const path=join(root,'exports');if(existsSync(path)&&lstatSync(path).isSymbolicLink())throw new Error('Archive folder must not be a symlink');mkdirSync(path,{recursive:true,mode:0o700});return path;}
function marker(root:string){return join(root,markerName);}
function writeResult(root:string,pending:PendingReplacement,status:ReplacementResult['status']){
 const path=join(root,resultName),temp=path+'.'+randomUUID()+'.tmp';
 try{writeFileSync(temp,JSON.stringify({status,kind:pending.kind,backup:pending.backup,at:new Date().toISOString()}),{flag:'wx',mode:0o600});renameSync(temp,path);}
 catch(error){rmSync(temp,{force:true});throw error;}
}
export function replacementResult(root:string):ReplacementResult|null{
 const path=join(root,resultName);if(!existsSync(path))return null;regular(path);
 const value=JSON.parse(readFileSync(path,'utf8')) as ReplacementResult;
 if(!['applied','stale'].includes(value.status)||!['compaction','restore'].includes(value.kind)||!namePattern.test(value.backup)||typeof value.at!=='string')throw new Error('Storage replacement result is invalid');
 return value;
}
function readPending(root:string):PendingReplacement|null{
 const path=marker(root);if(!existsSync(path))return null;regular(path);
 const value=JSON.parse(readFileSync(path,'utf8')) as Partial<PendingReplacement>;
 if(!namePattern.test(value.candidate||'')||!namePattern.test(value.backup||'')||value.candidate===value.backup||!digestPattern.test(value.sourceHash||'')||!digestPattern.test(value.candidateHash||'')||!['compaction','restore'].includes(value.kind||''))throw new Error('Pending storage replacement is invalid');
 return value as PendingReplacement;
}
function writePending(root:string,pending:PendingReplacement){
 writeFileSync(marker(root),JSON.stringify(pending),{flag:'wx',mode:0o600});
}
function verifyDatabase(path:string){
 regular(path);const db=new DatabaseSync(path,{readOnly:true});
 try{
  if(db.prepare('PRAGMA quick_check(1)').get()?.quick_check!=='ok')throw new Error('Storage integrity check failed');
  for(const table of ['events','human_decisions','manual_notes','observation_signatures'])
   if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))throw new Error('Storage schema is incomplete');
  for(const row of db.prepare('SELECT event_id,observed_at,payload FROM events ORDER BY rowid').iterate()){
   const event=JSON.parse(String(row.payload)) as CaptureEvent;validateEvent(event);
   if(event.eventId!==row.event_id||event.observedAt!==row.observed_at)throw new Error('Storage event columns do not match their payload');
  }
 }
 finally{db.close();}
}
function checkpoint(path:string){
 const db=new DatabaseSync(path);
 try{
  const result=db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  if(Number(result?.busy)!==0||db.prepare('PRAGMA quick_check(1)').get()?.quick_check!=='ok')throw new Error('Storage is busy or damaged');
 }finally{db.close();}
 if(existsSync(path+'-wal')&&statSync(path+'-wal').size>0)throw new Error('Storage still has an open write-ahead log');
}
export function prepareCompaction(root:string,options:{idleThreshold:number;agentIdleThreshold:number},revision:()=>string):PreparedCompaction{
 if(existsSync(marker(root)))throw new Error('A storage replacement is already pending');
 const source=join(root,'events.sqlite'),exports=folder(root);regular(source);
 checkpoint(source);
 const capacity=statfsSync(root),free=Number(capacity.bavail)*Number(capacity.bsize),required=statSync(source).size+64*1024*1024;
 if(free<required)throw new Error(`Preparing a recoverable copy needs about ${Math.ceil(required/1024/1024)} MB free`);
 const initial=revision(),sourceHash=hash(source),candidate=named(),backup=named(),target=join(exports,candidate);
 let report:CompactCopyResult;
 try{
  report=compactCaptureCopy(source,target,options);
  if(revision()!==initial||hash(source)!==sourceHash)throw new Error('Tracking data changed while the compacted copy was prepared');
  const savingsBytes=report.beforeBytes-report.afterBytes;
  if(savingsBytes<=0)throw new Error('Compaction would not save disk space');
  writePending(root,{candidate,backup,sourceHash,candidateHash:hash(target),kind:'compaction'});
  return {...report,candidate,backup,savingsBytes};
 }catch(error){rmSync(target,{force:true});throw error;}
}
export function prepareRestore(root:string,candidate:string):{candidate:string;backup:string;bytes:number}{
 if(existsSync(marker(root)))throw new Error('A storage replacement is already pending');
 if(!namePattern.test(candidate))throw new Error('Invalid archive name');
 const source=join(root,'events.sqlite'),archive=join(folder(root),candidate);regular(source);verifyDatabase(archive);
 checkpoint(source);
 const backup=named();
 writePending(root,{candidate,backup,sourceHash:hash(source),candidateHash:hash(archive),kind:'restore'});
 return {candidate,backup,bytes:statSync(archive).size};
}
export function cancelPendingReplacement(root:string):boolean{
 const pending=readPending(root);if(!pending)return false;
 rmSync(marker(root));
 if(pending.kind==='compaction')rmSync(join(folder(root),pending.candidate),{force:true});
 return true;
}
export function pendingReplacement(root:string):PendingReplacement|null{return readPending(root);}
function noOtherOpenHandle(path:string){
 if(process.platform!=='darwin')return;
 try{
  const output=execFileSync('/usr/sbin/lsof',['-t',path],{encoding:'utf8'}).trim();
  if(output)throw new Error('Another app instance still has the tracking database open');
 }catch(error){
  if(error instanceof Error&&error.message.startsWith('Another app instance'))throw error;
  if((error as {status?:number}).status!==1)throw new Error('Could not verify that the tracking database is closed');
 }
}
function rejectLiveCaptureLock(root:string){
 const path=join(root,'capture.lock');if(!existsSync(path))return;
 regular(path);const pid=Number(readFileSync(path,'utf8'));
 if(!Number.isInteger(pid)||pid<1)throw new Error('Unreadable collector lock; inspect before replacing storage');
 try{process.kill(pid,0);}catch(error){
  if((error as NodeJS.ErrnoException).code==='ESRCH'){unlinkSync(path);return;}
  throw error;
 }
 throw new Error('Capture is active; storage replacement was not applied');
}
function clearClosedJournal(path:string){
 for(const suffix of ['-wal','-shm']){
  const sidecar=path+suffix;if(!existsSync(sidecar))continue;
  regular(sidecar);
  if(suffix==='-wal'&&statSync(sidecar).size>0)throw new Error('Uncheckpointed storage write-ahead log remains');
  unlinkSync(sidecar);
 }
}
export function applyPendingReplacement(root:string,checkOpenHandles=noOtherOpenHandle):'none'|'applied'|'stale'{
 const pending=readPending(root);if(!pending)return 'none';
 const source=join(root,'events.sqlite'),archive=join(folder(root),pending.candidate),backup=join(root,'exports',pending.backup);
 rejectLiveCaptureLock(root);
 if(!existsSync(source)&&existsSync(backup)){renameSync(backup,source);rmSync(marker(root));writeResult(root,pending,'stale');return 'stale';}
 if(!existsSync(source))throw new Error('Tracking database is missing');
 checkOpenHandles(source);
 checkpoint(source);
 clearClosedJournal(source);
 if(hash(source)===pending.candidateHash&&existsSync(backup)){rmSync(marker(root));writeResult(root,pending,'applied');return 'applied';}
 regular(archive);verifyDatabase(archive);
 checkOpenHandles(archive);
 if(hash(source)!==pending.sourceHash||hash(archive)!==pending.candidateHash){rmSync(marker(root));writeResult(root,pending,'stale');return 'stale';}
 if(existsSync(backup))throw new Error('Recovery archive already exists');
 renameSync(source,backup);
 try{
  renameSync(archive,source);chmodSync(source,0o600);verifyDatabase(source);
  rmSync(marker(root));writeResult(root,pending,'applied');
  return 'applied';
 }catch(error){
  if(existsSync(source))renameSync(source,archive);
  if(existsSync(backup))renameSync(backup,source);
  throw error;
 }
}
