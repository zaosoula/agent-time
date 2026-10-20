import { DatabaseSync,backup } from 'node:sqlite';
import { mkdirSync, chmodSync, openSync, closeSync,existsSync,lstatSync,statSync,renameSync,rmSync } from 'node:fs';
import { dirname,join } from 'node:path';
import { validateEvent, type CaptureEvent } from './events.ts';
import type {HumanDecision} from './human-review.ts';
import {observationKey,observationSignature} from './observation-retention.ts';
import {randomUUID} from 'node:crypto';

export interface ManualNote {id:string;start:number;end:number;project:string;note:string;createdAt:number;}
export function validateManualNote(value:unknown):Omit<ManualNote,'id'|'createdAt'>{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid manual note');
 const item=value as Record<string,unknown>;
 if(Object.keys(item).sort().join(',')!=='end,note,project,start'||typeof item.start!=='number'||typeof item.end!=='number'||!Number.isFinite(item.start)||!Number.isFinite(item.end)||item.end<=item.start||item.end-item.start>86400||typeof item.note!=='string'||!item.note.trim()||item.note.length>500||typeof item.project!=='string'||item.project.length>256)throw new Error('Invalid manual note');
 const first=new Date(item.start*1000),last=new Date((item.end-0.001)*1000);
 if(!Number.isFinite(first.getTime())||!Number.isFinite(last.getTime())||first.toDateString()!==last.toDateString())throw new Error('Manual note must stay within one local day');
 return {start:item.start,end:item.end,project:item.project.trim(),note:item.note.trim()};
}

export class EventStore {
  private db: DatabaseSync;private generation=0;
  constructor(path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      closeSync(openSync(path, 'a', 0o600)); chmodSync(path, 0o600);
    }
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS events (event_id TEXT PRIMARY KEY, observed_at REAL NOT NULL, payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS events_observed_at ON events(observed_at); CREATE INDEX IF NOT EXISTS events_hooks ON events(observed_at) WHERE json_extract(payload,'$.source')='hook'; CREATE INDEX IF NOT EXISTS events_source_recent ON events(json_extract(payload,'$.source')); CREATE TABLE IF NOT EXISTS observation_signatures (identity TEXT PRIMARY KEY, signature TEXT NOT NULL); CREATE TABLE IF NOT EXISTS human_decisions (start_event_id TEXT NOT NULL, end_event_id TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('assigned','unassigned')), project_path TEXT, decided_at REAL NOT NULL, PRIMARY KEY(start_event_id,end_event_id)); CREATE TABLE IF NOT EXISTS manual_notes (id TEXT PRIMARY KEY,start REAL NOT NULL,end REAL NOT NULL,project TEXT NOT NULL,note TEXT NOT NULL,created_at REAL NOT NULL); CREATE INDEX IF NOT EXISTS manual_notes_start ON manual_notes(start)`);
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
  quickCheck():boolean{try{return this.db.prepare('PRAGMA quick_check(1)').get()?.quick_check==='ok';}catch{return false;}}
  revision():string{return `${this.generation}:${this.db.prepare('PRAGMA data_version').get()?.data_version}`;}
  events(): CaptureEvent[] {
    // Preserve causal insertion order across process epochs. Reducers sort per source epoch.
    return this.db.prepare('SELECT payload FROM events ORDER BY rowid').all().map(r => JSON.parse(String(r.payload)) as CaptureEvent);
  }
  settingsEvents():CaptureEvent[]{
    // Startup only needs setting boundaries; reading every captured observation
    // here made a large archive cost hundreds of MB before the first summary.
    return this.db.prepare("SELECT payload FROM events WHERE json_extract(payload,'$.source')='capture' ORDER BY rowid").all()
      .map(row=>JSON.parse(String(row.payload)) as CaptureEvent).filter(event=>event.kind==='capture_settings');
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
  manualNotes(date:string):ManualNote[]{
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new Error('Invalid date');
    const start=new Date(date+'T00:00:00');if(Number.isNaN(start.getTime())||date!==`${start.getFullYear()}-${String(start.getMonth()+1).padStart(2,'0')}-${String(start.getDate()).padStart(2,'0')}`)throw new Error('Invalid date');
    const end=new Date(start);end.setDate(end.getDate()+1);
    return this.db.prepare('SELECT id,start,end,project,note,created_at createdAt FROM manual_notes WHERE start>=? AND start<? ORDER BY start LIMIT 500').all(start.getTime()/1000,end.getTime()/1000).map(row=>({...row})) as unknown as ManualNote[];
  }
  addManualNote(input:unknown):ManualNote{
    const note=validateManualNote(input),saved={...note,id:randomUUID(),createdAt:Date.now()/1000};
    this.db.prepare('INSERT INTO manual_notes VALUES(?,?,?,?,?,?)').run(saved.id,saved.start,saved.end,saved.project,saved.note,saved.createdAt);
    return saved;
  }
  removeManualNote(id:string):boolean{
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id))throw new Error('Invalid manual note ID');
    return this.db.prepare('DELETE FROM manual_notes WHERE id=?').run(id).changes>0;
  }
  async exportArchive(output:string):Promise<{path:string;bytes:number;events:number}>{
    const folder=join(output,'exports');
    if(existsSync(folder)&&lstatSync(folder).isSymbolicLink())throw new Error('Export folder must not be a symlink');
    mkdirSync(folder,{recursive:true,mode:0o700});
    const stamp=new Date().toISOString().replaceAll(/[:.]/g,'-');
    const path=join(folder,`agent-time-${stamp}-${randomUUID()}.sqlite`),temp=path+'.tmp';
    try{
      await backup(this.db,temp);
      const check=new DatabaseSync(temp,{readOnly:true});
      let events:number;
      try{if(check.prepare('PRAGMA quick_check(1)').get()?.quick_check!=='ok')throw new Error('Export integrity check failed');events=Number(check.prepare('SELECT COUNT(*) count FROM events').get()?.count||0);}
      finally{check.close();}
      chmodSync(temp,0o600);renameSync(temp,path);
      return {path,bytes:statSync(path).size,events};
    }catch(error){if(existsSync(temp))rmSync(temp);throw error;}
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
