import {DatabaseSync} from 'node:sqlite';
import {decodeEventBlock,MAX_BLOCK_EVENTS} from './packed-codec.ts';

export const EVENT_FORMAT=2;
export const DECODE_CACHE_BYTES=16*1024*1024;
const resetCache=new WeakMap<DatabaseSync,()=>void>();
const caches=new WeakMap<DatabaseSync,Map<string,{rows:string[];bytes:number}>>();
const packed=new WeakSet<DatabaseSync>();
const quote=(name:string)=>'"'+name.replaceAll('"','""')+'"';
export function eventLocator(key:string,slot:number):Buffer{
 if(!/^[a-f0-9]{64}$/.test(key)||!Number.isInteger(slot)||slot<0||slot>=MAX_BLOCK_EVENTS)throw new Error('Invalid event locator');
 const result=Buffer.alloc(36);result[0]=65;result[1]=2;Buffer.from(key,'hex').copy(result,2);result.writeUInt16BE(slot,34);return result;
}
function locator(value:unknown):{key:string;slot:number}{
 if(!(value instanceof Uint8Array)||value.length!==36||value[0]!==65||value[1]!==2)throw new Error('Corrupt event locator');
 const bytes=Buffer.from(value);return {key:bytes.subarray(2,34).toString('hex'),slot:bytes.readUInt16BE(34)};
}
export function openEventDatabase(path:string,options:{readOnly?:boolean}={}):DatabaseSync{
 const db=new DatabaseSync(path,options),cache=new Map<string,{rows:string[];bytes:number}>();let cachedBytes=0;
 caches.set(db,cache);resetCache.set(db,()=>{cache.clear();cachedBytes=0;});
 const read=(key:string)=>{
  // Content hashes, rather than per-file IDs, make attached archives unambiguous.
  for(const schema of db.prepare('PRAGMA database_list').all()){
   const name=quote(String(schema.name));
   if(!db.prepare(`SELECT 1 FROM ${name}.sqlite_master WHERE type='table' AND name='at_event_blocks'`).get())continue;
   const block=db.prepare(`SELECT data FROM ${name}.at_event_blocks WHERE key=?`).get(key);
   if(block)return decodeEventBlock(block.data as Uint8Array,key);
  }
  throw new Error('Missing packed event block');
 };
 db.function('at_event_payload',{deterministic:true},value=>{
  if(typeof value==='string')return value;
  const {key,slot}=locator(value);let hit=cache.get(key);
  if(hit){cache.delete(key);cache.set(key,hit);}else{
   const rows=read(key),bytes=rows.reduce((n,row)=>n+row.length*2+64,0)+rows.length*8;
   hit={rows,bytes};while(cachedBytes+bytes>DECODE_CACHE_BYTES&&cache.size){const oldest=cache.keys().next().value!;cachedBytes-=cache.get(oldest)!.bytes;cache.delete(oldest);}
   if(bytes<=DECODE_CACHE_BYTES){cache.set(key,hit);cachedBytes+=bytes;}
  }
  if(slot>=hit.rows.length)throw new Error('Corrupt packed event slot');return hit.rows[slot]!;
 });
 const close=db.close.bind(db);db.close=()=>{cache.clear();close();};
 try{
  const version=Number(db.prepare('PRAGMA user_version').get()?.user_version);
  if(version>EVENT_FORMAT)throw new Error('This database needs a newer Agent Time reader');
  db.exec('PRAGMA busy_timeout=3000; PRAGMA cache_size=-8192; PRAGMA mmap_size=0; PRAGMA temp_store=FILE; PRAGMA temp.cache_size=-8192');
  if(version===EVENT_FORMAT)packed.add(db);
  return db;
 }catch(error){db.close();throw error;}
}
export function isPackedEventDatabase(db:DatabaseSync):boolean{return packed.has(db);}
export function createPackedEventSchema(db:DatabaseSync):void{
 db.exec(`PRAGMA auto_vacuum=INCREMENTAL;
 CREATE TABLE events(rowid INTEGER PRIMARY KEY,event_id TEXT UNIQUE NOT NULL,observed_at REAL NOT NULL,payload_data BLOB NOT NULL,
 payload TEXT GENERATED ALWAYS AS(CASE WHEN typeof(payload_data)='text' THEN payload_data ELSE at_event_payload(payload_data) END) VIRTUAL,
 source TEXT GENERATED ALWAYS AS(json_extract(payload,'$.source')) STORED,
 payload_bytes INTEGER GENERATED ALWAYS AS(length(CAST(payload AS BLOB))) STORED);
 CREATE TABLE at_event_blocks(key TEXT PRIMARY KEY,data BLOB NOT NULL,original_bytes INTEGER NOT NULL,event_count INTEGER NOT NULL) WITHOUT ROWID;
 PRAGMA user_version=2`);packed.add(db);
}
export function upgradeEventSchema(db:DatabaseSync):void{
 if(isPackedEventDatabase(db))return;
 const indexes=db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='events' AND sql IS NOT NULL").all().map(row=>String(row.sql));
 db.exec('BEGIN IMMEDIATE');try{
  db.exec('ALTER TABLE events RENAME TO at_legacy_events');
  createPackedEventSchema(db);
  db.exec('INSERT INTO events(rowid,event_id,observed_at,payload_data) SELECT rowid,event_id,observed_at,payload FROM at_legacy_events ORDER BY rowid; DROP TABLE at_legacy_events');
  for(const sql of indexes)db.exec(sql);
  db.exec('COMMIT');
 }catch(error){db.exec('ROLLBACK');packed.delete(db);throw error;}
}
export function insertEventRow(db:DatabaseSync,id:string,at:number,payload:string):boolean{
 const field=isPackedEventDatabase(db)?'payload_data':'payload';
 return Number(db.prepare(`INSERT OR IGNORE INTO events(event_id,observed_at,${field}) VALUES(?,?,?)`).run(id,at,payload).changes)>0;
}
/** Cold verification deliberately bypasses the decoder cache. */
export function verifyPackedBlocks(db:DatabaseSync):void{
 if(!isPackedEventDatabase(db))return;
 const counts=new Map<string,number>();
 for(const row of db.prepare('SELECT key,data,original_bytes,event_count FROM at_event_blocks').iterate()){
  const rows=decodeEventBlock(row.data as Uint8Array,String(row.key));
  if(counts.size>=1024)counts.delete(counts.keys().next().value!);counts.set(String(row.key),rows.length);
  if(rows.length!==row.event_count||rows.reduce((n,p)=>n+Buffer.byteLength(p),0)!==row.original_bytes)throw new Error('Corrupt packed event metadata');
 }
 for(const row of db.prepare("SELECT payload_data FROM events WHERE typeof(payload_data)='blob'").iterate()){
  const {key,slot}=locator(row.payload_data);let count=counts.get(key);if(count===undefined){const block=db.prepare('SELECT event_count FROM at_event_blocks WHERE key=?').get(key);if(block){count=Number(block.event_count);if(counts.size>=1024)counts.delete(counts.keys().next().value!);counts.set(key,count);}}
  if(count===undefined||slot>=count)throw new Error('Missing packed event block or invalid slot');
 }
 resetCache.get(db)?.();
}
export function eventStorageStats(db:DatabaseSync):{hotEvents:number;coldEvents:number;hotBytes:number;originalBytes:number;compressedBytes:number;cacheBytes:number}{
 const total=()=>Number(db.prepare('SELECT count(*) n FROM events').get()?.n||0);
 if(!isPackedEventDatabase(db))return {hotEvents:total(),coldEvents:0,hotBytes:0,originalBytes:0,compressedBytes:0,cacheBytes:0};
 const rows=db.prepare("SELECT sum(typeof(payload_data)='text') hotEvents,sum(typeof(payload_data)='blob') coldEvents,coalesce(sum(CASE WHEN typeof(payload_data)='text' THEN payload_bytes ELSE 0 END),0) hotBytes FROM events").get()!;
 const blocks=db.prepare('SELECT coalesce(sum(original_bytes),0) originalBytes,coalesce(sum(length(data)),0) compressedBytes FROM at_event_blocks').get()!;
 return {hotEvents:Number(rows.hotEvents||0),coldEvents:Number(rows.coldEvents||0),hotBytes:Number(rows.hotBytes),originalBytes:Number(blocks.originalBytes),compressedBytes:Number(blocks.compressedBytes),cacheBytes:[...(caches.get(db)?.values()||[])].reduce((n,v)=>n+v.bytes,0)};
}
