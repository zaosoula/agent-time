import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openEventDatabase,createPackedEventSchema,upgradeEventSchema,insertEventRow,eventLocator,verifyPackedBlocks,eventStorageStats} from '../src/capture/event-database.ts';
import {encodeEventBlock} from '../src/capture/packed-codec.ts';
const payload=(id:string)=>JSON.stringify({eventId:id,observedAt:20,source:'hook',kind:'tool_end',data:{unicode:'é'}});
test('legacy upgrade preserves sequence gaps, exact JSON, indexed queries and writable logical rows',()=>{
 const db=openEventDatabase(':memory:');try{
 db.exec('CREATE TABLE events(event_id TEXT PRIMARY KEY,observed_at REAL,payload TEXT);CREATE INDEX events_source ON events(json_extract(payload,\'$.source\'))');
 db.prepare('INSERT INTO events(rowid,event_id,observed_at,payload) VALUES(7,?,?,?)').run('a',20,payload('a'));
 upgradeEventSchema(db);assert.equal(db.prepare('SELECT rowid,payload FROM events').get()?.rowid,7);
 assert.equal(db.prepare("SELECT payload FROM events INDEXED BY events_source WHERE json_extract(payload,'$.source')='hook'").get()?.payload,payload('a'));
 assert.equal(insertEventRow(db,'b',21,payload('b')),true);assert.equal(insertEventRow(db,'b',21,payload('b')),false);
 db.exec('VACUUM');assert.deepEqual(db.prepare('SELECT rowid FROM events ORDER BY rowid').all().map(r=>r.rowid),[7,8]);
 assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check,'ok');
 }finally{db.close();}
});
test('attached content addressed blocks reconstruct correct payloads across databases and reject corruption',()=>{
 const root=mkdtempSync(join(tmpdir(),'at-db-'));const paths=['one','two'].map(v=>join(root,v));
 try{
 for(let n=0;n<2;n++){const db=openEventDatabase(paths[n]!);try{createPackedEventSchema(db);const raw=payload(String(n)),block=encodeEventBlock([raw]);db.prepare('INSERT INTO at_event_blocks(key,data,original_bytes,event_count) VALUES(?,?,?,?)').run(block.key,block.data,block.originalBytes,1);db.prepare('INSERT INTO events(event_id,observed_at,payload_data) VALUES(?,?,?)').run(String(n),20,eventLocator(block.key,0));verifyPackedBlocks(db);}finally{db.close();}}
 const db=openEventDatabase(paths[0]!);try{
 db.prepare('ATTACH DATABASE ? AS archive').run(paths[1]!);
 assert.equal(db.prepare('SELECT payload FROM events').get()?.payload,payload('0'));
 assert.equal(db.prepare('SELECT payload FROM archive.events').get()?.payload,payload('1'));
 assert.equal(eventStorageStats(db).coldEvents,1);
 db.exec("UPDATE at_event_blocks SET data=x'0102'");assert.throws(()=>verifyPackedBlocks(db),/digest|Corrupt/);
 }finally{db.close();}
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('new schema supports raw noncanonical payloads and rejects newer reader floors',()=>{
 const db=openEventDatabase(':memory:');createPackedEventSchema(db);const raw=' {"source":"hook"} ';insertEventRow(db,'a',1,raw);assert.equal(db.prepare('SELECT payload FROM events').get()?.payload,raw);db.close();
 const root=mkdtempSync(join(tmpdir(),'at-version-')),path=join(root,'db');const old=new DatabaseSync(path);old.exec('PRAGMA user_version=999');old.close();try{assert.throws(()=>openEventDatabase(path),/newer/);}finally{rmSync(root,{recursive:true,force:true});}
});
test('cold block verification reuses bounded metadata instead of rereading compressed bodies per event',()=>{
 const db=openEventDatabase(':memory:');try{createPackedEventSchema(db);const raw=payload('same'),block=encodeEventBlock([raw]);db.prepare('INSERT INTO at_event_blocks(key,data,original_bytes,event_count) VALUES(?,?,?,?)').run(block.key,block.data,block.originalBytes,1);const put=db.prepare('INSERT INTO events(event_id,observed_at,payload_data) VALUES(?,?,?)');for(let i=0;i<2000;i++)put.run(String(i),20,eventLocator(block.key,0));const prepare=db.prepare.bind(db);let lookups=0;db.prepare=(sql:string)=>{if(sql==='SELECT event_count FROM at_event_blocks WHERE key=?')lookups++;return prepare(sql);};verifyPackedBlocks(db);assert.ok(lookups<=1,`metadata looked up ${lookups} times`);}finally{db.close();}
});
test('structural SQLite checks skip decompression while a separate stream validates every payload and metadata',async()=>{
 const {checkEventDatabase}=await import('../src/capture/event-database.ts');const db=openEventDatabase(':memory:');try{createPackedEventSchema(db);const raw=payload('a'),block=encodeEventBlock([raw]);db.prepare('INSERT INTO at_event_blocks(key,data,original_bytes,event_count) VALUES(?,?,?,?)').run(block.key,block.data,block.originalBytes,1);db.prepare('INSERT INTO events(event_id,observed_at,payload_data) VALUES(?,?,?)').run('a',20,eventLocator(block.key,0));
 db.function('at_event_payload',{deterministic:true},(_value)=>{throw new Error('payload decoded during structural check');});assert.throws(()=>db.prepare('SELECT payload FROM events').get(),/decoded/);assert.equal(checkEventDatabase(db,false),true);
 db.function('at_event_payload',{deterministic:true},(_value)=>raw);assert.equal(checkEventDatabase(db),true);db.exec("UPDATE at_event_blocks SET data=x'0102'");assert.throws(()=>checkEventDatabase(db),/digest/);
 }finally{db.close();}
});
test('oversized compressed bodies are refused before materializing their bytes',()=>{
 const db=openEventDatabase(':memory:');try{createPackedEventSchema(db);db.exec("INSERT INTO at_event_blocks(key,data,original_bytes,event_count) VALUES('"+'0'.repeat(64)+"',zeroblob(5*1024*1024),1,1)");assert.throws(()=>verifyPackedBlocks(db),/compressed.*limit/i);}finally{db.close();}
});
test('decoder reuses native read statements after cache eviction and releases attached readers',()=>{
 const root=mkdtempSync(join(tmpdir(),'at-statements-')),path=join(root,'archive');const db=openEventDatabase(path);try{createPackedEventSchema(db);const raw=payload('a'),block=encodeEventBlock([raw]);db.prepare('INSERT INTO at_event_blocks(key,data,original_bytes,event_count) VALUES(?,?,?,?)').run(block.key,block.data,block.originalBytes,1);db.prepare('INSERT INTO events(event_id,observed_at,payload_data) VALUES(?,?,?)').run('a',20,eventLocator(block.key,0));const prepare=db.prepare.bind(db);let reads=0;db.prepare=(sql:string)=>{if(sql==='SELECT data FROM "main".at_event_blocks WHERE key=?')reads++;return prepare(sql);};const read=db.prepare('SELECT payload FROM events');for(let i=0;i<10;i++){verifyPackedBlocks(db);assert.equal(read.get()?.payload,raw);}assert.ok(reads<=1,`decoder prepared ${reads} repeated native statements`);
 const main=openEventDatabase(':memory:');try{for(let i=0;i<2;i++){main.prepare('ATTACH DATABASE ? AS archive').run(path);assert.equal(main.prepare('SELECT payload FROM archive.events').get()?.payload,raw);main.exec('DETACH DATABASE archive');}}finally{main.close();}
 }finally{db.close();rmSync(root,{recursive:true,force:true});}
});
