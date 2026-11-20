import type {DatabaseSync} from 'node:sqlite';
import type {CaptureEvent} from './events.ts';
export interface IngestMeta {
 eventId:string;source:string;kind:string;observedAt:number;indexedAt?:number;
 provider?:string;hostId?:string;sessionId?:string;agentId?:string;terminalHandle?:string;terminalIncarnation?:string;toolId?:string;taskCounterId?:string;url?:string;
}
const fields=['eventId','source','kind','observedAt','provider','hostId','sessionId','agentId','terminalHandle','terminalIncarnation','toolId','taskCounterId','url'] as const;
export function ingestionMeta(event:CaptureEvent):IngestMeta {
 const meta:Record<string,unknown>={};for(const field of fields){const value=field==='toolId'||field==='taskCounterId'||field==='url'?event.data?.[field]:event[field];if(value!==undefined)meta[field]=value;}return meta as unknown as IngestMeta;
}
export interface IngestionChange {sequence:number;kind:'event'|'review'|'range'|'blocks';old?:IngestMeta;next?:IngestMeta;/** Event-id pairs for 'review', [start,end] seconds for 'range'. */pairs?:[string,string][]|[number,number][];}
/** Mutation journal is independent of append ingestion's resumable source rowid. */
export function ensureIngestionJournal(db:DatabaseSync,packed:boolean):void {
 db.exec('SAVEPOINT ingestion_schema');try{installIngestionJournal(db,packed);db.exec('RELEASE ingestion_schema');}catch(error){try{db.exec('ROLLBACK TO ingestion_schema;RELEASE ingestion_schema');}catch{}throw error;}
}
function installIngestionJournal(db:DatabaseSync,packed:boolean):void {
 const existing=Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name='at_ingestion_sequence'").get());
 db.exec(`CREATE TABLE IF NOT EXISTS at_ingestion_sequence(id INTEGER PRIMARY KEY CHECK(id=1),sequence INTEGER NOT NULL,schema_version INTEGER NOT NULL DEFAULT 0);
 INSERT OR IGNORE INTO at_ingestion_sequence(id,sequence) VALUES(1,0);
 CREATE TABLE IF NOT EXISTS at_ingestion_highwater(id INTEGER PRIMARY KEY CHECK(id=1),max_rowid INTEGER NOT NULL);
 INSERT INTO at_ingestion_highwater SELECT 1,coalesce(max(rowid),0) FROM events WHERE true ON CONFLICT(id) DO UPDATE SET max_rowid=max(max_rowid,excluded.max_rowid);
 CREATE TABLE IF NOT EXISTS at_ingestion_changes(sequence INTEGER PRIMARY KEY,kind TEXT NOT NULL,old_meta TEXT,next_meta TEXT,pairs TEXT);`);
 if(!db.prepare('PRAGMA table_info(at_ingestion_sequence)').all().some(row=>row.name==='schema_version'))db.exec('ALTER TABLE at_ingestion_sequence ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 0');
 const upgrade=Number(db.prepare('SELECT schema_version FROM at_ingestion_sequence WHERE id=1').get()!.schema_version)<2;
 if(upgrade){
  const names=['event_append','event_highwater','event_replace','event_update','event_delete',...['human_decisions','human_splits','agent_time_exclusions'].flatMap(table=>['INSERT','UPDATE','DELETE'].map(action=>table+'_'+action)), 'blocks_UPDATE','blocks_DELETE'];
  for(const name of names)db.exec('DROP TRIGGER IF EXISTS at_ingestion_'+name);
  if(existing)db.exec("UPDATE at_ingestion_sequence SET sequence=sequence+1 WHERE id=1;INSERT INTO at_ingestion_changes SELECT sequence,'blocks',NULL,NULL,NULL FROM at_ingestion_sequence WHERE id=1;DELETE FROM at_ingestion_changes WHERE sequence<=(SELECT sequence-10000 FROM at_ingestion_sequence WHERE id=1)");
 }
 const payload=(ref:string)=>packed?`CASE WHEN typeof(${ref}.payload_data)='text' THEN ${ref}.payload_data ELSE at_event_payload(hex(${ref}.payload_data)) END`:`${ref}.payload`;
 const meta=(ref:string)=>`json_object(${fields.map(field=>`'${field}',json_extract(${payload(ref)},'$.${field==='toolId'||field==='taskCounterId'||field==='url'?'data.':''}${field}')`).join(',')},'indexedAt',${ref}.observed_at)`;
 const write=(kind:string,old='NULL',next='NULL',pairs='NULL')=>`UPDATE at_ingestion_sequence SET sequence=sequence+1 WHERE id=1; INSERT INTO at_ingestion_changes SELECT sequence,'${kind}',${old},${next},${pairs} FROM at_ingestion_sequence WHERE id=1; DELETE FROM at_ingestion_changes WHERE sequence<=(SELECT sequence-10000 FROM at_ingestion_sequence WHERE id=1);`;
 db.exec(`CREATE TRIGGER IF NOT EXISTS at_ingestion_event_append AFTER INSERT ON events BEGIN
 UPDATE at_ingestion_sequence SET sequence=sequence+1 WHERE id=1 AND NEW.rowid<=(SELECT max_rowid FROM at_ingestion_highwater WHERE id=1);
 INSERT INTO at_ingestion_changes SELECT sequence,'event',NULL,${meta('NEW')},NULL FROM at_ingestion_sequence WHERE id=1 AND NEW.rowid<=(SELECT max_rowid FROM at_ingestion_highwater WHERE id=1);
 DELETE FROM at_ingestion_changes WHERE sequence<=(SELECT sequence-10000 FROM at_ingestion_sequence WHERE id=1);
 UPDATE at_ingestion_highwater SET max_rowid=max(max_rowid,NEW.rowid) WHERE id=1; END;
 CREATE TRIGGER IF NOT EXISTS at_ingestion_event_highwater AFTER UPDATE ON events BEGIN UPDATE at_ingestion_highwater SET max_rowid=max(max_rowid,NEW.rowid) WHERE id=1; END;
 CREATE TRIGGER IF NOT EXISTS at_ingestion_event_replace BEFORE INSERT ON events WHEN EXISTS(SELECT 1 FROM events WHERE (event_id=NEW.event_id OR rowid=NEW.rowid) AND (event_id IS NOT NEW.event_id OR observed_at IS NOT NEW.observed_at OR payload IS NOT (${payload('NEW')}))) BEGIN
 INSERT INTO at_ingestion_changes SELECT (SELECT sequence FROM at_ingestion_sequence WHERE id=1)+row_number() OVER (ORDER BY events.rowid),'event',${meta('events')},${meta('NEW')},NULL FROM events WHERE event_id=NEW.event_id OR rowid=NEW.rowid;
 UPDATE at_ingestion_sequence SET sequence=(SELECT max(sequence) FROM at_ingestion_changes) WHERE id=1;
 DELETE FROM at_ingestion_changes WHERE sequence<=(SELECT sequence-10000 FROM at_ingestion_sequence WHERE id=1); END;
 CREATE TRIGGER IF NOT EXISTS at_ingestion_event_update AFTER UPDATE ON events WHEN OLD.event_id IS NOT NEW.event_id OR OLD.observed_at IS NOT NEW.observed_at OR (${payload('OLD')}) IS NOT (${payload('NEW')}) BEGIN ${write('event',meta('OLD'),meta('NEW'))} END;
 CREATE TRIGGER IF NOT EXISTS at_ingestion_event_delete BEFORE DELETE ON events BEGIN ${write('event',meta('OLD'))} END;`);
 for(const table of ['human_decisions','human_splits']){
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table))continue;
  for(const action of ['INSERT','UPDATE','DELETE']){
   const refs=action==='UPDATE'?['OLD','NEW']:[action==='DELETE'?'OLD':'NEW'];
   const pairs=`json_array(${refs.map(ref=>`json_array(${ref}.start_event_id,${ref}.end_event_id)`).join(',')})`;
   db.exec(`CREATE TRIGGER IF NOT EXISTS at_ingestion_${table}_${action} AFTER ${action} ON ${table} BEGIN ${write('review','NULL','NULL',pairs)} END;`);
  }
 }
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='agent_time_exclusions'").get())for(const action of ['INSERT','UPDATE','DELETE']){
  const refs=action==='UPDATE'?['OLD','NEW']:[action==='DELETE'?'OLD':'NEW'];
  db.exec(`CREATE TRIGGER IF NOT EXISTS at_ingestion_agent_time_exclusions_${action} AFTER ${action} ON agent_time_exclusions BEGIN ${write('range','NULL','NULL',`json_array(${refs.map(ref=>`json_array(${ref}.start,${ref}.end)`).join(',')})`)} END;`);
 }
 if(packed)for(const action of ['UPDATE','DELETE'])db.exec(`CREATE TRIGGER IF NOT EXISTS at_ingestion_blocks_${action} BEFORE ${action} ON at_event_blocks BEGIN ${write('blocks')} END;`);
 db.exec('UPDATE at_ingestion_sequence SET schema_version=2 WHERE id=1');
}
export function ingestionJournalState(db:DatabaseSync):{sequence:number;firstSequence:number}{
 const sequence=Number(db.prepare('SELECT sequence FROM at_ingestion_sequence WHERE id=1').get()?.sequence??0);
 return {sequence,firstSequence:Number(db.prepare('SELECT min(sequence) n FROM at_ingestion_changes').get()?.n??sequence+1)};
}
export function readIngestionChanges(db:DatabaseSync,after:number,limit:number):IngestionChange[]{
 return db.prepare('SELECT * FROM at_ingestion_changes WHERE sequence>? ORDER BY sequence LIMIT ?').all(after,Math.max(0,Math.min(10000,Math.floor(limit)))).map(row=>{
 const result:IngestionChange={sequence:Number(row.sequence),kind:row.kind as IngestionChange['kind']};
 for(const [column,key] of [['old_meta','old'],['next_meta','next'],['pairs','pairs']] as const)if(row[column]!=null){const parsed=JSON.parse(String(row[column]));if(key!=='pairs')for(const field of Object.keys(parsed))if(parsed[field]===null)delete parsed[field];(result as unknown as Record<string,unknown>)[key]=parsed;}return result;
 });
}
