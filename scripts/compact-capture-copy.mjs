import {DatabaseSync} from 'node:sqlite';
import {chmodSync,existsSync,lstatSync,mkdirSync,statSync,unlinkSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {summarize} from '../src/capture/correlate.ts';
import {retainedObservationRows} from '../src/capture/observation-retention.ts';

const [sourceArg,targetArg,...extra]=process.argv.slice(2);
if(!sourceArg||!targetArg||extra.length)throw new Error('Usage: node scripts/compact-capture-copy.mjs SOURCE.sqlite OUTPUT.sqlite');
const source=resolve(sourceArg),target=resolve(targetArg);
const targetExists=(()=>{try{lstatSync(target);return true;}catch(error){if(error?.code==='ENOENT')return false;throw error;}})();
if(source===target||!existsSync(source)||targetExists)throw new Error('Source must exist and output must be a new, different path');
mkdirSync(dirname(target),{recursive:true,mode:0o700});

let copy;
try{
 const original=new DatabaseSync(source,{readOnly:true});
 let sourceIds,sourceSummary,sourceDecisions,sourceNotes;
 try{
  const sourceEvents=original.prepare('SELECT event_id,payload FROM events ORDER BY rowid').all();
  sourceIds=sourceEvents.map(row=>String(row.event_id));
  sourceSummary=summarize(sourceEvents.map(row=>JSON.parse(String(row.payload))));
  sourceDecisions=original.prepare('SELECT * FROM human_decisions ORDER BY start_event_id,end_event_id').all();
  sourceNotes=original.prepare('SELECT * FROM manual_notes ORDER BY id').all();
  original.prepare('VACUUM INTO ?').run(target);
 }finally{original.close();}
 chmodSync(target,0o600);
 copy=new DatabaseSync(target);
 const rows=copy.prepare('SELECT rowid,payload FROM events ORDER BY rowid').all().map(r=>({rowid:Number(r.rowid),event:JSON.parse(String(r.payload))}));
 if(rows.length!==sourceIds.length||rows.some((row,index)=>row.event.eventId!==sourceIds[index]))throw new Error('Copy changed event insertion order; compacted copy was rejected');
 const before=summarize(rows.map(r=>r.event));
 if(JSON.stringify(before)!==JSON.stringify(sourceSummary))throw new Error('Copy changed capture summary; compacted copy was rejected');
 const keep=retainedObservationRows(rows),remove=copy.prepare('DELETE FROM events WHERE rowid=?');
 copy.exec('BEGIN IMMEDIATE');
 try{
  for(const row of rows)if(!keep.has(row.rowid))remove.run(row.rowid);
  copy.exec('COMMIT');
 }catch(error){copy.exec('ROLLBACK');throw error;}
 const afterRows=copy.prepare('SELECT payload FROM events ORDER BY rowid').all().map(r=>JSON.parse(String(r.payload)));
 const after=summarize(afterRows);
 if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('Capture summary changed; compacted copy was rejected');
 if(copy.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok')throw new Error('Compacted copy failed SQLite integrity check');
 copy.exec('VACUUM');
 const finalRows=copy.prepare('SELECT event_id,payload FROM events ORDER BY rowid').all();
 const finalIds=finalRows.map(row=>String(row.event_id));
 const retainedIds=rows.filter(row=>keep.has(row.rowid)).map(row=>row.event.eventId);
 if(finalIds.length!==retainedIds.length||finalIds.some((id,index)=>id!==retainedIds[index]))throw new Error('Final vacuum changed event insertion order; compacted copy was rejected');
 if(JSON.stringify(summarize(finalRows.map(row=>JSON.parse(String(row.payload)))))!==JSON.stringify(before))throw new Error('Final vacuum changed capture summary; compacted copy was rejected');
 if(JSON.stringify(copy.prepare('SELECT * FROM human_decisions ORDER BY start_event_id,end_event_id').all())!==JSON.stringify(sourceDecisions)||JSON.stringify(copy.prepare('SELECT * FROM manual_notes ORDER BY id').all())!==JSON.stringify(sourceNotes))throw new Error('Review decisions or manual notes changed; compacted copy was rejected');
 if(copy.prepare('PRAGMA integrity_check').get()?.integrity_check!=='ok')throw new Error('Final compacted copy failed SQLite integrity check');
 const result={source,output:target,beforeRows:rows.length,afterRows:afterRows.length,beforeBytes:statSync(source).size,afterBytes:statSync(target).size,summaryIdentical:true};
 copy.close();copy=undefined;
 console.log(JSON.stringify(result));
}catch(error){
 copy?.close();
 for(const suffix of ['','-wal','-shm'])if(existsSync(target+suffix))unlinkSync(target+suffix);
 throw error;
}
