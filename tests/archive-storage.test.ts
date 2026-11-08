import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync,readdirSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,basename} from 'node:path';
import {compressArchive,withReadableArchive,maintainArchives,recordArchive} from '../src/capture/archive-storage.ts';
import {EventStore} from '../src/capture/store.ts';import {prepareRestoreAsync,pendingReplacement,cancelPendingReplacement} from '../src/capture/storage-migration.ts';
test('compressed archives round trip exact bytes, preview/import and prepare a recoverable restore',async()=>{
 const root=mkdtempSync(join(tmpdir(),'at-gzip-')),store=new EventStore(join(root,'events.sqlite'));
 try{store.put({eventId:'a',source:'capture',kind:'capture_start',observedAt:1,monotonicAt:1,collectorEpoch:'e'});const plain=await store.exportArchive(root),original=readFileSync(plain.path),result=await compressArchive(plain.path);assert.ok(result.bytes<original.length);assert.equal(existsSync(plain.path),false);assert.deepEqual(await withReadableArchive(result.path,path=>readFileSync(path)),original);
 assert.equal((await store.previewArchiveAsync(root,basename(result.path))).archiveEvents,1);assert.equal((await store.importArchiveAsync(root,basename(result.path))).addedEvents,0);store.close();
 const prepared=await prepareRestoreAsync(root,basename(result.path));assert.ok(existsSync(join(root,'exports',prepared.candidate)));assert.ok(pendingReplacement(root));assert.equal(cancelPendingReplacement(root),true);assert.equal(existsSync(join(root,'exports',prepared.candidate)),false);assert.equal(existsSync(result.path),true);
 }finally{try{store.close();}catch{}rmSync(root,{recursive:true,force:true});}
});
test('invalid gzip and refused publication keep originals and leave no staging files',async()=>{
 const root=mkdtempSync(join(tmpdir(),'at-gzip-bad-'));try{const path=join(root,'archive.sqlite');writeFileSync(path,'original');writeFileSync(path+'.gz','occupied');await assert.rejects(compressArchive(path),/exists/);assert.equal(readFileSync(path,'utf8'),'original');await assert.rejects(withReadableArchive(path+'.gz',()=>true),/header|compression|gzip|incorrect/);assert.deepEqual(readdirSync(root).sort(),['archive.sqlite','archive.sqlite.gz']);}finally{rmSync(root,{recursive:true,force:true});}
});
test('archive care preserves manual, unclassified, unique and newest automatic copies',async()=>{
 const root=mkdtempSync(join(tmpdir(),'at-care-')),store=new EventStore(join(root,'events.sqlite'));try{
 const copies=[];for(let i=0;i<5;i++){const archive=await store.exportArchive(root);copies.push(archive.path);if(i<4)recordArchive(root,basename(archive.path),i===0?'manual':'rollback');}
 const unique=basename(copies[1]!);const result=await maintainArchives(root,{maxAutomatic:1,maxAutomaticBytes:1,covered:async id=>!id.startsWith(unique)});assert.equal(result.removed.length,1);const files=store.listArchives(root).map(a=>a.id);assert.equal(files.length,4);for(const i of [0,1,3,4])assert.ok(files.includes(basename(copies[i]!)+'.gz'));
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
test('a source changed during compression stays present and unpublished',async()=>{
 const root=mkdtempSync(join(tmpdir(),'at-gzip-change-'));try{const path=join(root,'source.sqlite');writeFileSync(path,Buffer.alloc(16*1024*1024,1));const running=compressArchive(path);await new Promise(resolve=>setTimeout(resolve,0));writeFileSync(path,'changed');await assert.rejects(running,/changed|verification/);assert.equal(readFileSync(path,'utf8'),'changed');assert.equal(existsSync(path+'.gz'),false);assert.deepEqual(readdirSync(root),['source.sqlite']);}finally{rmSync(root,{recursive:true,force:true});}
});
test('abandoned decompression copies are cleaned without touching a live reader',async()=>{
 const {cleanupArchiveStaging}=await import('../src/capture/archive-storage.ts');const {mkdirSync}=await import('node:fs');const {lockText}=await import('../src/capture/capture-lock.ts');const root=mkdtempSync(join(tmpdir(),'at-stage-'));try{mkdirSync(join(root,'exports'));for(const [name,owner] of [['.archive-read-dead',JSON.stringify({pid:2147483647,started:null})],['.archive-read-live',lockText()]]){const folder=join(root,'exports',name);mkdirSync(folder);writeFileSync(join(folder,'owner.lock'),owner);writeFileSync(join(folder,'archive.sqlite'),'private data');}cleanupArchiveStaging(root);assert.equal(existsSync(join(root,'exports','.archive-read-dead')),false);assert.equal(existsSync(join(root,'exports','.archive-read-live')),true);}finally{rmSync(root,{recursive:true,force:true});}
});
test('compression stops at its temporary-space budget and keeps the original',async()=>{
 const root=mkdtempSync(join(tmpdir(),'at-gzip-budget-'));try{const path=join(root,'source.sqlite');writeFileSync(path,'original'.repeat(1000));await assert.rejects(compressArchive(path,1),/space|budget/);assert.equal(readFileSync(path,'utf8'),'original'.repeat(1000));assert.deepEqual(readdirSync(root),['source.sqlite']);}finally{rmSync(root,{recursive:true,force:true});}
});
test('archive identifiers remain usable after automatic compression changes the extension',async()=>{
 const root=mkdtempSync(join(tmpdir(),'at-archive-id-')),store=new EventStore(join(root,'events.sqlite'));try{const archive=await store.exportArchive(root),id=basename(archive.path);await compressArchive(archive.path);assert.equal((await store.previewArchiveAsync(root,id)).archiveEvents,0);assert.equal((await store.importArchiveAsync(root,id)).addedEvents,0);store.close();const pending=await prepareRestoreAsync(root,id);assert.ok(existsSync(join(root,'exports',pending.candidate)));cancelPendingReplacement(root);assert.equal(existsSync(archive.path+'.gz'),true);assert.equal(store.deleteArchive(root,id),true);}finally{try{store.close();}catch{}rmSync(root,{recursive:true,force:true});}
});
test('automatic cleanup preserves rollback order and every stored review column',async()=>{
 for(const change of ['event-order','review-at','review-mode','review-project','note-created','decision-at']){
  const root=mkdtempSync(join(tmpdir(),'at-care-detail-')),store=new EventStore(join(root,'events.sqlite'));
  try{
   for(const [id,at] of [['a',1],['b',2]] as const)store.put({eventId:id,source:'capture',kind:'capture_start',observedAt:at,monotonicAt:at,collectorEpoch:'e'});
   store.database.exec("INSERT INTO review_actions VALUES('review',1,'assigned','/project','{}','{}',NULL); INSERT INTO manual_notes VALUES('note',1,2,'/project','text',1); INSERT INTO human_decisions VALUES('a','b','assigned','/project',1)");
   const first=await store.exportArchive(root);recordArchive(root,basename(first.path),'rollback');
   const sql={
    'event-order':"UPDATE events SET rowid=-1 WHERE event_id='a'; UPDATE events SET rowid=1 WHERE event_id='b'; UPDATE events SET rowid=2 WHERE event_id='a'",
    'review-at':"UPDATE review_actions SET at=2",'review-mode':"UPDATE review_actions SET mode='unassigned'",'review-project':"UPDATE review_actions SET project_path='/other'",'note-created':"UPDATE manual_notes SET created_at=2",'decision-at':"UPDATE human_decisions SET decided_at=2",
   }[change]!;store.database.exec(sql);
   const second=await store.exportArchive(root);recordArchive(root,basename(second.path),'rollback');
   const result=await maintainArchives(root,{maxAutomatic:1,maxAutomaticBytes:1});assert.equal(result.removed.length,0,change);assert.ok(existsSync(first.path+'.gz'),change);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
 }
});
test('automatic cleanup removes exact redundant rollback rows and protects unknown unique tables',async()=>{
 for(const unique of [false,true]){
  const root=mkdtempSync(join(tmpdir(),'at-care-proof-')),store=new EventStore(join(root,'events.sqlite'));try{
   store.database.exec("CREATE TABLE custom_history(id TEXT PRIMARY KEY,value TEXT); INSERT INTO custom_history VALUES('a','original')");
   const first=await store.exportArchive(root);recordArchive(root,basename(first.path),'rollback');
   if(unique)store.database.exec("UPDATE custom_history SET value='changed'");
   const second=await store.exportArchive(root);recordArchive(root,basename(second.path),'rollback');
   const result=await maintainArchives(root,{maxAutomatic:1,maxAutomaticBytes:1});assert.equal(result.removed.length,unique?0:1);assert.equal(existsSync(first.path+'.gz'),unique);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
 }
});
