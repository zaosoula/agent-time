import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, openSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import { validateEvent, type CaptureEvent } from './events.ts';
import {observationKey,observationSignature} from './observation-retention.ts';

export class EventStore {
  private db: DatabaseSync;private generation=0;
  constructor(path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      closeSync(openSync(path, 'a', 0o600)); chmodSync(path, 0o600);
    }
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS events (event_id TEXT PRIMARY KEY, observed_at REAL NOT NULL, payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS events_hooks ON events(observed_at) WHERE json_extract(payload,'$.source')='hook'; CREATE TABLE IF NOT EXISTS observation_signatures (identity TEXT PRIMARY KEY, signature TEXT NOT NULL)`);
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
  close(): void { this.db.close(); }
}
