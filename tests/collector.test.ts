import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {Collector} from '../src/capture/collector.ts';
test('an inactive observer cannot consume spool or insert capture-stop into another owners database',async()=>{
 const path=mkdtempSync(join(tmpdir(),'ade-owner-'));const c=new Collector(path);await c.stop();assert.equal(c.store.events().length,0);await c.close();rmSync(path,{recursive:true});
});
test('stop kills its native helper while a metadata read is pending and cancels remaining reads',async()=>{
 const {writeFileSync,existsSync,readFileSync}=await import('node:fs');const {setTimeout:sleep}=await import('node:timers/promises');
 const path=mkdtempSync(join(tmpdir(),'ade-stop-'));const helper=join(path,'probe');const pidfile=join(path,'helper.pid');
 writeFileSync(helper,'#!/bin/sh\necho $$ > "'+pidfile+'"\nexec /bin/sleep 30\n',{mode:0o755});
 let release!:(value:unknown)=>void;let calls=0;const pending=new Promise(resolve=>{release=resolve;});
 const c=new Collector(path,helper,5,undefined,async()=>{calls++;return pending;});const started=c.start(30);
 for(let i=0;i<100&&!existsSync(pidfile);i++)await sleep(10);
 const pid=Number(readFileSync(pidfile,'utf8'));const stopped=c.stop();await sleep(50);
 try { assert.throws(()=>process.kill(pid,0),{code:'ESRCH'}); } finally {
  release({ok:true,result:{runs:[{id:'r1'}],nextCursor:null}});await Promise.all([started,stopped]);await c.close();rmSync(path,{recursive:true});
 }
 assert.equal(calls,1);
});
