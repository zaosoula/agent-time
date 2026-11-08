import {collectUnusedPackedBlocks} from './packed-maintenance.ts';
import {openEventDatabase,checkEventDatabase} from './event-database.ts';
import {DatabaseSync} from 'node:sqlite';
import {chmodSync,existsSync,lstatSync,mkdirSync,statSync,unlinkSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {observationKey,observationSignature,staticOrcaScopeReason} from './observation-retention.ts';
import {causalEvidenceDigest,emptyWorker,eventsDigest,otherTablesDigest,parsedRow,rowDigest,workerGroup} from './compact-verification.ts';

export interface CompactCopyResult {source:string;output:string;beforeRows:number;afterRows:number;beforeBytes:number;afterBytes:number;timeAndOtherCoverageIdentical:true;hostScopeDaysPreserved:number;}
const configure=(db:DatabaseSync)=>db.exec('PRAGMA cache_size=-8192; PRAGMA mmap_size=0; PRAGMA temp_store=FILE; PRAGMA temp.cache_size=-8192');
export function compactCaptureCopy(sourceArg:string,targetArg:string,_options:{idleThreshold?:number;agentIdleThreshold?:number}={}):CompactCopyResult {
 for(const threshold of [_options.idleThreshold??300,_options.agentIdleThreshold??300])if(!Number.isFinite(threshold)||threshold<=0)throw new Error('invalid idle threshold');
 const source=resolve(sourceArg),target=resolve(targetArg);
 const targetExists=(()=>{try{lstatSync(target);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}})();
 if(source===target||!existsSync(source)||targetExists)throw new Error('Source must exist and output must be a new, different path');
 mkdirSync(dirname(target),{recursive:true,mode:0o700});
 let copy:DatabaseSync|undefined;
 try{
  const original=openEventDatabase(source,{readOnly:true});
  let sourceEvents:string,sourceTables:string;
  try{
   configure(original);
   sourceEvents=eventsDigest(original);sourceTables=otherTablesDigest(original);
   original.prepare('VACUUM INTO ?').run(target);
  }finally{original.close();}
  chmodSync(target,0o600);
  copy=openEventDatabase(target);configure(copy);
  if(eventsDigest(copy)!==sourceEvents||otherTablesDigest(copy)!==sourceTables)throw new Error('Copy changed stored data; compacted copy was rejected');
  // Disk-backed retention state replaces arrays/sets proportional to payloads
  // and event count. Meaningful workers stay verbatim: their timestamps can
  // affect bounded hook binding even when their state appears unchanged.
  copy.exec(`CREATE TEMP TABLE compact_remove (rowid INTEGER PRIMARY KEY);
   CREATE TEMP TABLE compact_latest (identity TEXT PRIMARY KEY,rowid INTEGER,signature TEXT,middle INTEGER);
   CREATE TEMP TABLE compact_empty (rowid INTEGER PRIMARY KEY,identity TEXT);
   CREATE TEMP TABLE compact_blocked (identity TEXT PRIMARY KEY);
   CREATE TEMP TABLE compact_scope_days (day TEXT PRIMARY KEY)`);
  const latest=copy.prepare('SELECT rowid,signature,middle FROM compact_latest WHERE identity=?');
  const remember=copy.prepare('INSERT OR REPLACE INTO compact_latest VALUES(?,?,?,?)');
  const remove=copy.prepare('INSERT OR IGNORE INTO compact_remove VALUES(?)');
  const empty=copy.prepare('INSERT INTO compact_empty VALUES(?,?)'),block=copy.prepare('INSERT OR IGNORE INTO compact_blocked VALUES(?)');
  const scope=copy.prepare('INSERT OR IGNORE INTO compact_scope_days VALUES(?)');
  let beforeRows=0;
  copy.exec('BEGIN');
  try{
   for(const row of copy.prepare('SELECT rowid,event_id,observed_at,payload FROM events ORDER BY rowid').iterate()){
    const event=parsedRow(row),rowid=Number(row.rowid);beforeRows++;
    if(event.kind==='worker'){
     if(emptyWorker(event))empty.run(rowid,workerGroup(event));
     else block.run(workerGroup(event));
    }else if(event.source==='hook'&&event.dispatchId)block.run(workerGroup(event));
    const staticScope=event.source==='orca'&&event.kind==='coverage'&&event.data?.reason===staticOrcaScopeReason;
    if(staticScope)scope.run(new Date(event.observedAt*1000).toISOString().slice(0,10));
    if(event.source!=='orca'||event.kind!=='terminal'&&!staticScope)continue;
    const key=observationKey(event);if(!key)continue;
    const signature=observationSignature(event),previous=latest.get(key),same=previous?.signature===signature;
    if(same&&previous.middle)remove.run(previous.rowid!);
    remember.run(key,rowid,signature,same?1:0);
   }
   copy.exec('INSERT OR IGNORE INTO compact_remove SELECT rowid FROM compact_empty e WHERE NOT EXISTS (SELECT 1 FROM compact_blocked b WHERE b.identity=e.identity); COMMIT');
  }catch(error){copy.exec('ROLLBACK');throw error;}
  const blocked=copy.prepare('SELECT 1 FROM compact_blocked WHERE identity=?');
  const isEmptyGroup=(key:string)=>!blocked.get(key);
  const beforeEvidence=causalEvidenceDigest(copy,isEmptyGroup,true);
  const retainedEvents=eventsDigest(copy,'WHERE rowid NOT IN (SELECT rowid FROM compact_remove)');
  const scopeDays=()=>rowDigest(copy!.prepare(`SELECT DISTINCT strftime('%Y-%m-%d',observed_at,'unixepoch') day FROM events
   WHERE json_extract(payload,'$.source')='orca' AND json_extract(payload,'$.kind')='coverage' AND json_extract(payload,'$.data.reason')=? ORDER BY day`).iterate(staticOrcaScopeReason));
  const beforeDays=scopeDays();
  const hostScopeDaysPreserved=Number(copy.prepare('SELECT count(*) n FROM compact_scope_days').get()!.n);
  copy.exec('BEGIN IMMEDIATE');
  try{copy.exec('DELETE FROM events WHERE rowid IN (SELECT rowid FROM compact_remove); COMMIT');}
  catch(error){copy.exec('ROLLBACK');throw error;}
  collectUnusedPackedBlocks(copy);copy.exec('VACUUM');
  if(eventsDigest(copy)!==retainedEvents||otherTablesDigest(copy)!==sourceTables)throw new Error('Compaction changed retained data or insertion order; compacted copy was rejected');
  if(causalEvidenceDigest(copy,isEmptyGroup)!==beforeEvidence)throw new Error('Compaction changed causal evidence; compacted copy was rejected');
  if(scopeDays()!==beforeDays)throw new Error('Compaction changed coverage days; compacted copy was rejected');
  if(!checkEventDatabase(copy))throw new Error('Compacted copy failed SQLite integrity check');
  const afterRows=Number(copy.prepare('SELECT count(*) n FROM events').get()!.n);
  const result={source,output:target,beforeRows,afterRows,beforeBytes:statSync(source).size,afterBytes:statSync(target).size,timeAndOtherCoverageIdentical:true as const,hostScopeDaysPreserved};
  copy.close();copy=undefined;
  return result;
 }catch(error){
  copy?.close();
  for(const suffix of ['','-wal','-shm'])if(existsSync(target+suffix))unlinkSync(target+suffix);
  throw error;
 }
}
