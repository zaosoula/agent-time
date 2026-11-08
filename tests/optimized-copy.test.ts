import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {EventStore} from '../src/capture/store.ts';import {openEventDatabase,verifyPackedBlocks} from '../src/capture/event-database.ts';
import {eventsDigest,otherTablesDigest} from '../src/capture/compact-verification.ts';import {optimizedCaptureCopy} from '../src/capture/optimized-copy.ts';
test('optimized copy preserves every logical row, sequence gap, review and timing input while reducing bytes',()=>{
 const root=mkdtempSync(join(tmpdir(),'at-opt-')),source=join(root,'source'),target=join(root,'target');
 try{const store=new EventStore(source);store.transaction(()=>{for(let i=0;i<5000;i++)store.put({eventId:`event-${i}`,observedAt:i*2,monotonicAt:i*2,collectorEpoch:'epoch',source:'macos',kind:'activity',data:{appName:'Editor',title:'Long shared window title',idleSeconds:i%30}});});store.setHumanDecisions([['a','b']],'assigned','/project');store.database.exec('DELETE FROM events WHERE rowid=2');const before=eventsDigest(store.database),tables=otherTablesDigest(store.database),order=store.database.prepare('SELECT rowid FROM events ORDER BY rowid').all();store.close();
 const report=optimizedCaptureCopy(source,target);assert.equal(report.beforeRows,4999);assert.equal(report.afterRows,4999);assert.ok(report.afterBytes<report.beforeBytes);
 const db=openEventDatabase(target);try{verifyPackedBlocks(db);assert.equal(eventsDigest(db),before);assert.equal(otherTablesDigest(db),tables);assert.deepEqual(db.prepare('SELECT rowid FROM events ORDER BY rowid').all(),order);}finally{db.close();}
 assert.throws(()=>optimizedCaptureCopy(source,target),/new|different/);assert.equal(existsSync(source),true);
 const again=join(root,'again');assert.equal(optimizedCaptureCopy(target,again).afterRows,4999);
 }finally{rmSync(root,{recursive:true,force:true});}
});
