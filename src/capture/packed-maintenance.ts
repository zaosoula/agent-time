import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {isPackedEventDatabase,eventLocator} from './event-database.ts';
import {encodeEventBlock,toolIdentity,MAX_BLOCK_BYTES,MAX_BLOCK_EVENTS} from './packed-codec.ts';
export interface PackingResult {packedEvents:number;originalBytes:number;compressedBytes:number;toolCalls:number;indexedEvents:number;oversizedEvents:number;}
const key=(identity:string)=>createHash('sha256').update(identity).digest();
export function indexToolBoundaries(db:DatabaseSync,maxRows=20480):number{
 db.exec(`CREATE TABLE IF NOT EXISTS at_tool_keys(rowid INTEGER PRIMARY KEY,identity BLOB NOT NULL,phase TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS at_tool_identity ON at_tool_keys(identity);
 CREATE TABLE IF NOT EXISTS at_pack_state(id INTEGER PRIMARY KEY,last_rowid INTEGER NOT NULL);
 INSERT OR IGNORE INTO at_pack_state VALUES(1,0);
 CREATE INDEX IF NOT EXISTS at_events_hot ON events(observed_at) WHERE typeof(payload_data)='text'`);
 const cursor=Number(db.prepare('SELECT last_rowid FROM at_pack_state WHERE id=1').get()!.last_rowid),write=db.prepare('INSERT OR IGNORE INTO at_tool_keys VALUES(?,?,?)');let count=0,last=cursor;
 db.exec('BEGIN IMMEDIATE');try{
  for(const row of db.prepare("SELECT rowid,source,CASE WHEN source='hook' THEN payload ELSE NULL END payload FROM events WHERE rowid>? ORDER BY rowid LIMIT ?").iterate(cursor,maxRows)){
   last=Number(row.rowid);count++;if(row.source!=='hook')continue;
   const event=JSON.parse(String(row.payload)) as Record<string,unknown>,identity=toolIdentity(event);if(identity)write.run(last,key(identity),String(event.kind));
  }
  db.prepare('UPDATE at_pack_state SET last_rowid=? WHERE id=1').run(last);db.exec('COMMIT');return count;
 }catch(error){db.exec('ROLLBACK');throw error;}
}
export function packEventHistory(db:DatabaseSync,options:{now:number;hotBytes?:number;hotDays?:number;maxRows?:number;maxBytes?:number}):PackingResult{
 const result:PackingResult={packedEvents:0,originalBytes:0,compressedBytes:0,toolCalls:0,indexedEvents:0,oversizedEvents:0};if(!isPackedEventDatabase(db))return result;
 const maxRows=Math.max(1,Math.min(20480,Math.floor(options.maxRows??20480))),maxBytes=Math.max(1,Math.min(16*1024*1024,options.maxBytes??16*1024*1024));
 result.indexedEvents=indexToolBoundaries(db,maxRows);
 const last=Number(db.prepare('SELECT coalesce(max(rowid),0) n FROM events').get()!.n),cursor=Number(db.prepare('SELECT last_rowid FROM at_pack_state WHERE id=1').get()!.last_rowid),indexed=cursor>=last;
 let hot=Number(db.prepare("SELECT coalesce(sum(payload_bytes),0) n FROM events INDEXED BY at_events_hot WHERE typeof(payload_data)='text'").get()!.n);
 const cutoff=options.now-(options.hotDays??7)*86400,budget=options.hotBytes??128*1024*1024;
 // A bounded candidate list uses metadata only; unusually large legacy rows stay raw.
 const candidates=db.prepare("SELECT rowid,payload_bytes,observed_at FROM events INDEXED BY at_events_hot WHERE typeof(payload_data)='text' AND payload_bytes<=? AND (observed_at<? OR ? > ?) ORDER BY observed_at,rowid LIMIT ?").all(MAX_BLOCK_BYTES,cutoff,hot,budget,maxRows);
 let position=0;
 while(position<candidates.length&&result.packedEvents<maxRows&&result.originalBytes<maxBytes){
  const rows:Array<{rowid:number;payload:string}>=[];const selected=new Set<number>();let bytes=0;
  const add=(rowid:number)=>{
   if(selected.has(rowid)||rows.length>=Math.min(MAX_BLOCK_EVENTS,maxRows-result.packedEvents))return;
   const row=db.prepare("SELECT payload_data,payload_bytes FROM events WHERE rowid=? AND typeof(payload_data)='text'").get(rowid);if(!row)return;
   const size=Number(row.payload_bytes);if(size>MAX_BLOCK_BYTES||bytes+size>Math.min(MAX_BLOCK_BYTES,maxBytes-result.originalBytes))return;
   rows.push({rowid,payload:String(row.payload_data)});selected.add(rowid);bytes+=size;
  };
  while(position<candidates.length&&rows.length<Math.min(MAX_BLOCK_EVENTS,maxRows-result.packedEvents)){
   const candidate=candidates[position++]!;if(Number(candidate.observed_at)>=cutoff&&hot<=budget)break;
   if(bytes&&bytes+Number(candidate.payload_bytes)>Math.min(MAX_BLOCK_BYTES,maxBytes-result.originalBytes)){position--;break;}
   add(Number(candidate.rowid));
   if(indexed){const identity=db.prepare('SELECT identity FROM at_tool_keys WHERE rowid=?').get(candidate.rowid!);if(identity){const pair=db.prepare('SELECT rowid FROM at_tool_keys WHERE identity=? LIMIT 3').all(identity.identity!);if(pair.length===2)for(const item of pair)add(Number(item.rowid));}}
  }
  if(!rows.length)break;
  const identities=new Map<string,{start:number[];end:number[]}>();
  for(let slot=0;slot<rows.length;slot++){try{const event=JSON.parse(rows[slot]!.payload) as Record<string,unknown>,identity=toolIdentity(event);if(!identity||!indexed)continue;const group=identities.get(identity)||{start:[],end:[]};(event.kind==='tool_start'?group.start:group.end).push(slot);identities.set(identity,group);}catch{/* Raw fallback. */}}
  const pairs:Array<[number,number]>=[];
  for(const [identity,group] of identities)if(group.start.length===1&&group.end.length===1&&Number(db.prepare('SELECT count(*) n FROM at_tool_keys WHERE identity=?').get(key(identity))!.n)===2)pairs.push([group.start[0]!,group.end[0]!]);
  let block;
  for(;;){try{block=encodeEventBlock(rows.map(row=>row.payload),pairs.filter(([a,b])=>a<rows.length&&b<rows.length));break;}catch(error){if(!(error instanceof Error)||!error.message.includes('codec size')||rows.length<2)throw error;rows.splice(Math.ceil(rows.length/2));bytes=rows.reduce((n,row)=>n+Buffer.byteLength(row.payload),0);}}

  db.exec('BEGIN IMMEDIATE');try{
   db.prepare('INSERT OR IGNORE INTO at_event_blocks VALUES(?,?,?,?)').run(block.key,block.data,block.originalBytes,block.count);
   const write=db.prepare("UPDATE events SET payload_data=? WHERE rowid=? AND typeof(payload_data)='text' AND payload_data=?");
   for(let slot=0;slot<rows.length;slot++){const row=rows[slot]!;if(Number(write.run(eventLocator(block.key,slot),row.rowid,row.payload).changes)!==1)throw new Error('History changed during packing; retry later');}
   db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  result.packedEvents+=rows.length;result.originalBytes+=bytes;result.compressedBytes+=block.data.length;result.toolCalls+=block.records.toolCalls;hot-=bytes;
 }
 // No logical rows are removed by packing. Only wholly unreferenced blocks can go.
 db.exec("CREATE TEMP TABLE IF NOT EXISTS at_live_blocks(key TEXT PRIMARY KEY) WITHOUT ROWID; DELETE FROM at_live_blocks; INSERT OR IGNORE INTO at_live_blocks SELECT lower(hex(substr(payload_data,3,32))) FROM events WHERE typeof(payload_data)='blob'; DELETE FROM at_event_blocks WHERE key NOT IN (SELECT key FROM at_live_blocks); PRAGMA incremental_vacuum(256)");
 result.oversizedEvents=Number(db.prepare("SELECT count(*) n FROM events WHERE typeof(payload_data)='text' AND payload_bytes>?").get(MAX_BLOCK_BYTES)!.n);
 return result;
}
