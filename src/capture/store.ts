import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, openSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import { validateEvent, type CaptureEvent } from './events.ts';

export class EventStore {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      closeSync(openSync(path, 'a', 0o600)); chmodSync(path, 0o600);
    }
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS events (event_id TEXT PRIMARY KEY, observed_at REAL NOT NULL, payload TEXT NOT NULL)');
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
    return true;
  }
  events(): CaptureEvent[] {
    // Preserve causal insertion order across process epochs. Reducers sort per source epoch.
    return this.db.prepare('SELECT payload FROM events ORDER BY rowid').all().map(r => JSON.parse(String(r.payload)) as CaptureEvent);
  }
  close(): void { this.db.close(); }
}
