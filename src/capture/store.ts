import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, openSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import { validateEvent, type CaptureEvent } from './events.ts';
import type {HumanDecision} from './human-review.ts';
import {observationKey,observationSignature} from './observation-retention.ts';

export class EventStore {
  private db: DatabaseSync;private generation=0;
  constructor(path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      closeSync(openSync(path, 'a', 0o600)); chmodSync(path, 0o600);
    }
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS events (event_id TEXT PRIMARY KEY, observed_at REAL NOT NULL, payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS events_hooks ON events(observed_at) WHERE json_extract(payload,'$.source')='hook'; CREATE INDEX IF NOT EXISTS events_source_recent ON events(json_extract(payload,'$.source')); CREATE TABLE IF NOT EXISTS observation_signatures (identity TEXT PRIMARY KEY, signature TEXT NOT NULL); CREATE TABLE IF NOT EXISTS human_decisions (start_event_id TEXT NOT NULL, end_event_id TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('assigned','unassigned')), project_path TEXT, decided_at REAL NOT NULL, PRIMARY KEY(start_event_id,end_event_id))`);
  }
  put(event: CaptureEvent): boolean {
    validateEvent(event);
    const payload = JSON.stringify(event);
    const existing = this.db.prepare('SELECT payload FROM events WHERE event_id=?').get(event.eventId);
    if (existing) {
      if (existing.payload !== payload) throw new Error('event ID conflict');
      return false;
    }
    this.db.prepare('INSERT INTO events VALUES (?, ?, ?)').run(event.eventId, event.observedAt, payload);
    this.generation++;return true;
  }
  putObservations(events:CaptureEvent[]):number {
    const before=this.generation;
    const read=this.db.prepare('SELECT signature FROM observation_signatures WHERE identity=?');
    const write=this.db.prepare('INSERT INTO observation_signatures VALUES(?,?) ON CONFLICT(identity) DO UPDATE SET signature=excluded.signature');
    this.db.exec('BEGIN');
    try {
      let inserted=0;
      for(const event of events){
        validateEvent(event);
        const key=observationKey(event),signature=key?observationSignature(event):null;
        if(key&&read.get(key)?.signature===signature)continue;
        if(this.put(event)){
          inserted++;
          if(key)write.run(key,signature);
        }
      }
      this.db.exec('COMMIT');return inserted;
    }catch(error){this.db.exec('ROLLBACK');this.generation=before;throw error;}
  }
  count():number{return Number(this.db.prepare('SELECT COUNT(*) count FROM events').get()?.count||0);}
  revision():string{return `${this.generation}:${this.db.prepare('PRAGMA data_version').get()?.data_version}`;}
  events(): CaptureEvent[] {
    // Preserve causal insertion order across process epochs. Reducers sort per source epoch.
    return this.db.prepare('SELECT payload FROM events ORDER BY rowid').all().map(r => JSON.parse(String(r.payload)) as CaptureEvent);
  }
  humanDecisions():HumanDecision[]{
    return this.db.prepare('SELECT start_event_id, end_event_id, mode, project_path FROM human_decisions').all().map(row=>({startEventId:String(row.start_event_id),endEventId:String(row.end_event_id),mode:row.mode as HumanDecision['mode'],projectPath:row.project_path===null?null:String(row.project_path)}));
  }
  setHumanDecisions(pairs:Array<[string,string]>,mode:'assigned'|'unassigned'|'clear',projectPath:string|null):void {
    const put=this.db.prepare('INSERT INTO human_decisions (start_event_id,end_event_id,mode,project_path,decided_at) VALUES (?,?,?,?,?) ON CONFLICT(start_event_id,end_event_id) DO UPDATE SET mode=excluded.mode,project_path=excluded.project_path,decided_at=excluded.decided_at');
    const remove=this.db.prepare('DELETE FROM human_decisions WHERE start_event_id=? AND end_event_id=?');
    this.db.exec('BEGIN');
    try{
      for(const [start,end] of pairs){if(mode==='clear')remove.run(start,end);else put.run(start,end,mode,projectPath,Date.now()/1000);}
      this.db.exec('COMMIT');this.generation++;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  recent(source:string,limit:number,provider?:string):CaptureEvent[]{
    if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('Invalid recent event limit');
    const query=provider
      ? "SELECT payload FROM events WHERE json_extract(payload,'$.source')=? AND json_extract(payload,'$.provider')=? ORDER BY rowid DESC LIMIT ?"
      : "SELECT payload FROM events WHERE json_extract(payload,'$.source')=? ORDER BY rowid DESC LIMIT ?";
    const rows=provider?this.db.prepare(query).all(source,provider,limit):this.db.prepare(query).all(source,limit);
    return rows.map(r=>JSON.parse(String(r.payload)) as CaptureEvent);
  }
  close(): void { this.db.close(); }
}
