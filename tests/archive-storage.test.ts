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
