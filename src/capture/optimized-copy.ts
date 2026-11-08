import {chmodSync,existsSync,lstatSync,mkdirSync,statSync,rmSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {openEventDatabase,upgradeEventSchema,verifyPackedBlocks,isPackedEventDatabase} from './event-database.ts';
import {eventsDigest,otherTablesDigest,rowDigest} from './compact-verification.ts';
import {indexToolBoundaries,packEventHistory} from './packed-maintenance.ts';
import type {CompactCopyResult} from './compact-copy.ts';
/** A verified lossless format upgrade, never an in-place migration. */
export function optimizedCaptureCopy(sourceArg:string,targetArg:string):CompactCopyResult{
 const source=resolve(sourceArg),target=resolve(targetArg);
 if(source===target||!existsSync(source)||existsSync(target))throw new Error('Source must exist and output must be a new, different path');
 if(!lstatSync(source).isFile()||lstatSync(source).isSymbolicLink())throw new Error('Source must be a regular database');
 mkdirSync(dirname(target),{recursive:true,mode:0o700});
 const original=openEventDatabase(source,{readOnly:true});
 try{
  const beforeBytes=statSync(source).size,beforeRows=Number(original.prepare('SELECT count(*) n FROM events').get()!.n),events=eventsDigest(original),tables=otherTablesDigest(original);
  const order=rowDigest(original.prepare('SELECT rowid,event_id FROM events ORDER BY rowid').iterate());
  // Backup preserves legacy physical rowids, including intentional gaps.
  original.prepare('VACUUM INTO ?').run(target);chmodSync(target,0o600);
  const db=openEventDatabase(target);
  try{
   // Legacy VACUUM can renumber rowids, so restore original sequence explicitly.
   if(eventsDigest(db)!==events)throw new Error('Copy changed event order');
   if(!isPackedEventDatabase(db)){
    // Refill the private legacy copy in the source's original rowid order before
    // introducing the generated column. This also preserves negative/gapped IDs.
    db.exec('BEGIN IMMEDIATE; DELETE FROM events');
    try{const put=db.prepare('INSERT INTO events(rowid,event_id,observed_at,payload) VALUES(?,?,?,?)');for(const row of original.prepare('SELECT rowid,event_id,observed_at,payload FROM events ORDER BY rowid').iterate())put.run(row.rowid!,row.event_id!,row.observed_at!,row.payload!);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
   }
   upgradeEventSchema(db);db.exec('PRAGMA auto_vacuum=INCREMENTAL');
   while(indexToolBoundaries(db,20480)===20480){/* Bounded batches, complete global identities before pair packing. */}
   while(packEventHistory(db,{now:Date.now()/1000,hotBytes:0,hotDays:0}).packedEvents){/* Each pass commits at most16 MiB. */}
   verifyPackedBlocks(db);
   if(eventsDigest(db)!==events||otherTablesDigest(db)!==tables||rowDigest(db.prepare('SELECT rowid,event_id FROM events ORDER BY rowid').iterate())!==order)throw new Error('Lossless storage verification failed; original data is unchanged');
   db.exec('VACUUM');
   if(db.prepare('PRAGMA quick_check(1)').get()?.quick_check!=='ok')throw new Error('Optimized database integrity check failed');
   verifyPackedBlocks(db);
   if(eventsDigest(db)!==events||otherTablesDigest(db)!==tables)throw new Error('Final storage verification failed');
  }finally{db.close();}
  return {source,output:target,beforeRows,afterRows:beforeRows,beforeBytes,afterBytes:statSync(target).size,timeAndOtherCoverageIdentical:true,hostScopeDaysPreserved:0};
 }catch(error){rmSync(target,{force:true});throw error;}finally{original.close();}
}
