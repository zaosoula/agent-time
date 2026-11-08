import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {validateEvent,type CaptureEvent} from './events.ts';
import {informativeWorker,staticOrcaScopeReason} from './observation-retention.ts';
import {compareCausalPosition} from './correlate.ts';

export const workerGroup=(event:CaptureEvent)=>`${event.hostId}:${event.dispatchId}`;
/** These snapshots only create zero-time, unknown, hostless sessions. A group
 * containing any other worker or dispatch-bound hook is excluded separately. */
export function emptyWorker(event:CaptureEvent):boolean{
 return event.source==='orca'&&event.kind==='worker'&&event.hostId===undefined&&event.terminalHandle===undefined&&event.sessionId===undefined&&!informativeWorker(event);
}
export function ignoredObservation(event:CaptureEvent,isEmptyGroup:(key:string)=>boolean):boolean{
 return event.source==='orca'&&(event.kind==='terminal'||event.kind==='coverage'&&event.data?.reason===staticOrcaScopeReason||emptyWorker(event)&&isEmptyGroup(workerGroup(event)));
}
export function parsedRow(row:Record<string,unknown>):CaptureEvent{
 const event=JSON.parse(String(row.payload)) as CaptureEvent;validateEvent(event);
 if(event.eventId!==row.event_id||event.observedAt!==row.observed_at)throw new Error('Storage event columns do not match their payload; compacted copy was rejected');
 return event;
}

/** Stream complete row values, including type/column boundaries and insertion
 * order. Physical rowids are deliberately absent: VACUUM may renumber them. */
export function rowDigest(rows:Iterable<Record<string,unknown>>):string{
 const digest=createHash('sha256');
 for(const row of rows)digest.update(JSON.stringify(row,(_key,value)=>typeof value==='bigint'?{$bigint:String(value)}:value)+'\n');
 return digest.digest('hex');
}
export const eventsDigest=(db:DatabaseSync,where='')=>rowDigest(db.prepare(`SELECT event_id,observed_at,payload FROM events ${where} ORDER BY rowid`).iterate());
export function otherTablesDigest(db:DatabaseSync):string{
 const digest=createHash('sha256');
 for(const table of db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name<>'events' AND name NOT IN ('at_event_blocks','at_tool_keys','at_pack_state') ORDER BY name").iterate()){
  const name=String(table.name).replaceAll('"','""');
  digest.update(JSON.stringify(table)+'\n');
  digest.update(rowDigest(db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).iterate()));
 }
 return digest.digest('hex');
}

/**
 * Exact global causal order used by summarize(), without retaining payloads or
 * producing millions of intervals. About 45 bytes per event plus epoch names
 * replace multiple histories of parsed objects and serialized summaries.
 *
 * Every input row, including those we plan to remove, participates in the
 * original normalization/sort. A deletion that changes the order of meaningful
 * evidence (including a wall-clock rollback) is therefore rejected. Use the
 * same stable Array.sort and localeCompare as correlate.ts, not SQLite order.
 */
export function causalEvidenceDigest(db:DatabaseSync,isEmptyGroup:(key:string)=>boolean,protectClockEnvelopes=false):string{
 const count=Number(db.prepare('SELECT count(*) n FROM events').get()!.n);
 const rowids=new Float64Array(count),monotonic=new Float64Array(count),times=new Float64Array(count),epochs=new Uint32Array(count),ignored=new Uint8Array(count),removed=protectClockEnvelopes?new Uint8Array(count):undefined;
 const epochIds=new Map<string,number>(),epochNames:string[]=[],order:number[]=new Array(count);
 let index=0;
 const query=protectClockEnvelopes?'SELECT e.rowid,e.event_id,e.observed_at,e.payload,r.rowid IS NOT NULL removed FROM events e LEFT JOIN compact_remove r ON r.rowid=e.rowid ORDER BY e.rowid':'SELECT rowid,event_id,observed_at,payload FROM events ORDER BY rowid';
 for(const row of db.prepare(query).iterate()){
  const event=parsedRow(row);
  let epoch=epochIds.get(event.collectorEpoch);
  if(epoch===undefined){epoch=epochIds.size;epochIds.set(event.collectorEpoch,epoch);epochNames.push(event.collectorEpoch);}
  rowids[index]=Number(row.rowid);monotonic[index]=event.monotonicAt;times[index]=event.observedAt;epochs[index]=epoch;
  ignored[index]=ignoredObservation(event,isEmptyGroup)?1:0;order[index]=index;index++;
  if(removed)removed[index-1]=Number(row.removed);
 }
 if(index!==count)throw new Error('Storage changed during verification; compacted copy was rejected');
 const ids=new Map<number,string>(),readId=db.prepare('SELECT event_id FROM events WHERE rowid=?');
 const id=(index:number)=>{
  let value=ids.get(index);
  if(value===undefined){
   value=String(readId.get(rowids[index]!)!.event_id);
   if(ids.size>=4096)ids.clear();
   ids.set(index,value);
  }
  return value;
 };
 order.sort((a,b)=>epochs[a]!-epochs[b]!||monotonic[a]!-monotonic[b]!||id(a).localeCompare(id(b)));
 let previousEpoch=-1,time=-Infinity,anchor=0;
 const keep=protectClockEnvelopes?db.prepare('DELETE FROM compact_remove WHERE rowid=?'):undefined;
 for(const index of order){
  if(epochs[index]!==previousEpoch){previousEpoch=epochs[index]!;time=-Infinity;}
  if(times[index]!>time)anchor=index;
  time=Math.max(time,times[index]!);times[index]=time;
  // An otherwise inert row may be the wall-clock watermark for later kept
  // evidence. Retain that anchor rather than losing a rollback boundary.
  if(removed&&!removed[index]&&removed[anchor]){keep!.run(rowids[anchor]!);removed[anchor]=0;}
 }
 // summarize's global sort starts from insertion order, not epoch order.
 for(let index=0;index<count;index++)order[index]=index;
 order.sort((a,b)=>times[a]!-times[b]!||compareCausalPosition(epochNames[epochs[a]!]!,monotonic[a]!,epochNames[epochs[b]!]!,monotonic[b]!)||id(a).localeCompare(id(b)));
 const digest=createHash('sha256');
 for(const index of order)if(!ignored[index])digest.update(JSON.stringify(id(index))+'\n');
 return digest.digest('hex');
}
