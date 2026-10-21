import {DatabaseSync} from 'node:sqlite';
import {chmodSync,existsSync,lstatSync,mkdirSync,statSync,unlinkSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {summarize} from './correlate.ts';
import {retainedObservationRows,staticOrcaScopeReason} from './observation-retention.ts';
import type {CaptureEvent,Summary} from './events.ts';

export interface CompactCopyResult {source:string;output:string;beforeRows:number;afterRows:number;beforeBytes:number;afterBytes:number;timeAndOtherCoverageIdentical:true;hostScopeDaysPreserved:number;}
export function compactCaptureCopy(sourceArg:string,targetArg:string,options:{idleThreshold?:number;agentIdleThreshold?:number}={}):CompactCopyResult {
const source=resolve(sourceArg),target=resolve(targetArg);
const targetExists=(()=>{try{lstatSync(target);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}})();
if(source===target||!existsSync(source)||targetExists)throw new Error('Source must exist and output must be a new, different path');
mkdirSync(dirname(target),{recursive:true,mode:0o700});
const comparable=(summary:Summary)=>JSON.stringify({...summary,coverage:summary.coverage.filter(issue=>issue.reason!==staticOrcaScopeReason)});
const scopeDays=(events:CaptureEvent[])=>[...new Set(events.filter(event=>event.source==='orca'&&event.kind==='coverage'&&event.data?.reason===staticOrcaScopeReason).map(event=>new Date(event.observedAt*1000).toISOString().slice(0,10)))].sort();

let copy;
try{
 const original=new DatabaseSync(source,{readOnly:true});
 let sourceIds,sourceSummary,sourceScopeDays,sourceDecisions,sourceNotes;
 try{
  const hasTable=(name:string)=>Boolean(original.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  const sourceEvents=original.prepare('SELECT event_id,payload FROM events ORDER BY rowid').all();
  sourceIds=sourceEvents.map(row=>String(row.event_id));
  const parsed=sourceEvents.map(row=>JSON.parse(String(row.payload)));
  sourceSummary=summarize(parsed,options);sourceScopeDays=scopeDays(parsed);
  sourceDecisions=hasTable('human_decisions')?original.prepare('SELECT * FROM human_decisions ORDER BY start_event_id,end_event_id').all():null;
  sourceNotes=hasTable('manual_notes')?original.prepare('SELECT * FROM manual_notes ORDER BY id').all():null;
  original.prepare('VACUUM INTO ?').run(target);
 }finally{original.close();}
 chmodSync(target,0o600);
 copy=new DatabaseSync(target);
 const rows=copy.prepare('SELECT rowid,payload FROM events ORDER BY rowid').all().map(r=>({rowid:Number(r.rowid),event:JSON.parse(String(r.payload))}));
 if(rows.length!==sourceIds.length||rows.some((row,index)=>row.event.eventId!==sourceIds[index]))throw new Error('Copy changed event insertion order; compacted copy was rejected');
 const before=summarize(rows.map(r=>r.event),options);
 if(comparable(before)!==comparable(sourceSummary)||JSON.stringify(scopeDays(rows.map(row=>row.event)))!==JSON.stringify(sourceScopeDays))throw new Error('Copy changed capture summary; compacted copy was rejected');
 const keep=retainedObservationRows(rows),remove=copy.prepare('DELETE FROM events WHERE rowid=?');
 copy.exec('BEGIN IMMEDIATE');
 try{
  for(const row of rows)if(!keep.has(row.rowid))remove.run(row.rowid);
  copy.exec('COMMIT');
 }catch(error){copy.exec('ROLLBACK');throw error;}
 const afterRows=copy.prepare('SELECT payload FROM events ORDER BY rowid').all().map(r=>JSON.parse(String(r.payload)));
 const after=summarize(afterRows,options);
 if(comparable(before)!==comparable(after)||JSON.stringify(scopeDays(afterRows))!==JSON.stringify(sourceScopeDays))throw new Error('Capture summary changed; compacted copy was rejected');
 if(copy.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok')throw new Error('Compacted copy failed SQLite integrity check');
 copy.exec('VACUUM');
 const finalRows=copy.prepare('SELECT event_id,payload FROM events ORDER BY rowid').all();
 const finalIds=finalRows.map(row=>String(row.event_id));
 const retainedIds=rows.filter(row=>keep.has(row.rowid)).map(row=>row.event.eventId);
 if(finalIds.length!==retainedIds.length||finalIds.some((id,index)=>id!==retainedIds[index]))throw new Error('Final vacuum changed event insertion order; compacted copy was rejected');
 const finalEvents=finalRows.map(row=>JSON.parse(String(row.payload)));
 if(comparable(summarize(finalEvents,options))!==comparable(before)||JSON.stringify(scopeDays(finalEvents))!==JSON.stringify(sourceScopeDays))throw new Error('Final vacuum changed capture summary; compacted copy was rejected');
 if(sourceDecisions&&JSON.stringify(copy.prepare('SELECT * FROM human_decisions ORDER BY start_event_id,end_event_id').all())!==JSON.stringify(sourceDecisions)||sourceNotes&&JSON.stringify(copy.prepare('SELECT * FROM manual_notes ORDER BY id').all())!==JSON.stringify(sourceNotes))throw new Error('Review decisions or manual notes changed; compacted copy was rejected');
 if(copy.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok')throw new Error('Final compacted copy failed SQLite integrity check');
 const result={source,output:target,beforeRows:rows.length,afterRows:afterRows.length,beforeBytes:statSync(source).size,afterBytes:statSync(target).size,timeAndOtherCoverageIdentical:true as const,hostScopeDaysPreserved:sourceScopeDays.length};
 copy.close();copy=undefined;
 return result;
}catch(error){
 copy?.close();
 for(const suffix of ['','-wal','-shm'])if(existsSync(target+suffix))unlinkSync(target+suffix);
 throw error;
}
}
