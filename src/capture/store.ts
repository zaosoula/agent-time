import { DatabaseSync,backup } from 'node:sqlite';
import { mkdirSync, chmodSync, openSync, closeSync,existsSync,lstatSync,statSync,renameSync,rmSync,readdirSync,unlinkSync } from 'node:fs';
import { dirname,join } from 'node:path';
import { validateEvent, type CaptureEvent } from './events.ts';
import type {HumanDecision} from './human-review.ts';
import {observationKey,observationSignature} from './observation-retention.ts';
import {randomUUID} from 'node:crypto';

export interface ManualNote {id:string;start:number;end:number;project:string;note:string;createdAt:number;}
export interface ArchivePreview {id:string;archiveEvents:number;newEvents:number;eventConflicts:number;newNotes:number;noteConflicts:number;newDecisions:number;decisionConflicts:number;newUsageEvents:number;usageConflicts:number;}
const archiveName=/^agent-time-[0-9TZ-]+-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.sqlite$/;
export function validateManualNote(value:unknown):Omit<ManualNote,'id'|'createdAt'>{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid manual note');
 const item=value as Record<string,unknown>;
 if(Object.keys(item).sort().join(',')!=='end,note,project,start'||typeof item.start!=='number'||typeof item.end!=='number'||!Number.isFinite(item.start)||!Number.isFinite(item.end)||item.end<=item.start||item.end-item.start>86400||typeof item.note!=='string'||!item.note.trim()||item.note.length>500||typeof item.project!=='string'||item.project.length>256)throw new Error('Invalid manual note');
 const first=new Date(item.start*1000),last=new Date((item.end-0.001)*1000);
 if(!Number.isFinite(first.getTime())||!Number.isFinite(last.getTime())||first.toDateString()!==last.toDateString())throw new Error('Manual note must stay within one local day');
 return {start:item.start,end:item.end,project:item.project.trim(),note:item.note.trim()};
}

export class EventStore {
  private db: DatabaseSync;private generation=0;private nonEventGeneration=0;
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
  checkpointWal():void{
    const result=this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if(Number(result?.busy)!==0)throw new Error('Storage is busy; try again after capture settles');
    if(!this.quickCheck())throw new Error('Database integrity check failed after checkpoint');
  }
  revision():string{return `${this.generation}:${this.db.prepare('PRAGMA data_version').get()?.data_version}`;}
  incrementalSafetyRevision():string{return `${this.nonEventGeneration}:${this.db.prepare('PRAGMA data_version').get()?.data_version}`;}
  events(): CaptureEvent[] {
    // Preserve causal insertion order across process epochs. Reducers sort per source epoch.
    const events:CaptureEvent[]=[];
    for(const row of this.db.prepare('SELECT payload FROM events ORDER BY rowid').iterate())
      events.push(JSON.parse(String(row.payload)) as CaptureEvent);
    return events;
  }
  lastEventRowid():number{return Number(this.db.prepare('SELECT COALESCE(MAX(rowid),0) rowid FROM events').get()?.rowid||0);}
  eventsAfterRowid(rowid:number):Array<{rowid:number;event:CaptureEvent}>{
    if(!Number.isSafeInteger(rowid)||rowid<0)throw new Error('Invalid event cursor');
    return this.db.prepare('SELECT rowid,payload FROM events WHERE rowid>? ORDER BY rowid').all(rowid)
      .map(row=>({rowid:Number(row.rowid),event:JSON.parse(String(row.payload)) as CaptureEvent}));
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
      this.db.exec('COMMIT');this.generation++;this.nonEventGeneration++;
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
  listArchives(output:string):Array<{id:string;bytes:number}>{
    const folder=join(output,'exports');
    if(!existsSync(folder))return [];
    if(lstatSync(folder).isSymbolicLink())throw new Error('Export folder must not be a symlink');
    return readdirSync(folder).filter(id=>archiveName.test(id)).flatMap(id=>{
      const info=lstatSync(join(folder,id));
      return info.isFile()&&!info.isSymbolicLink()?[{id,bytes:info.size}]:[];
    }).sort((a,b)=>b.id.localeCompare(a.id));
  }
  deleteArchive(output:string,id:string):boolean{
    if(!archiveName.test(id))throw new Error('Invalid archive ID');
    const folder=join(output,'exports');
    if(!existsSync(folder)||lstatSync(folder).isSymbolicLink())throw new Error('Archive folder is unavailable');
    const path=join(folder,id);
    if(!existsSync(path))return false;
    const info=lstatSync(path);
    if(!info.isFile()||info.isSymbolicLink())throw new Error('Archive must be a regular file');
    unlinkSync(path);
    return true;
  }
  private withArchive<T>(output:string,id:string,run:(hasUsage:boolean)=>T):T{
    if(!archiveName.test(id))throw new Error('Invalid archive ID');
    const folder=join(output,'exports'),path=join(folder,id);
    if(lstatSync(folder).isSymbolicLink()||!lstatSync(path).isFile()||lstatSync(path).isSymbolicLink())throw new Error('Archive must be a regular file');
    const check=new DatabaseSync(path,{readOnly:true});
    try{
      if(check.prepare('PRAGMA quick_check(1)').get()?.quick_check!=='ok')throw new Error('Archive integrity check failed');
      for(const table of ['events','human_decisions','manual_notes','observation_signatures'])
        if(!check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))throw new Error('Archive schema is incomplete');
    }finally{check.close();}
    this.db.prepare('ATTACH DATABASE ? AS archive').run(path);
    try{
      const hasUsage=Boolean(this.db.prepare("SELECT name FROM archive.sqlite_master WHERE type='table' AND name='usage_events'").get());
      return run(hasUsage);
    }finally{this.db.exec('DETACH DATABASE archive');}
  }
  previewArchive(output:string,id:string):ArchivePreview{
    return this.withArchive(output,id,hasUsage=>this.previewAttachedArchive(id,hasUsage));
  }
  importArchive(output:string,id:string):{addedEvents:number;addedNotes:number;addedDecisions:number}{
    return this.withArchive(output,id,hasUsage=>{
      const preview=this.previewAttachedArchive(id,hasUsage);
      if(preview.eventConflicts||preview.noteConflicts||preview.decisionConflicts||preview.usageConflicts)throw new Error('Archive conflicts with current evidence or review decisions; no data was changed');
      for(const row of this.db.prepare('SELECT event_id,observed_at,payload FROM archive.events a WHERE NOT EXISTS (SELECT 1 FROM main.events m WHERE m.event_id=a.event_id)').iterate()){
        const event=JSON.parse(String(row.payload)) as CaptureEvent;
        validateEvent(event);
        if(event.eventId!==row.event_id||event.observedAt!==row.observed_at)throw new Error('Archive event columns do not match the payload');
      }
      if(hasUsage)for(const row of this.db.prepare('SELECT id,timestamp,payload FROM archive.usage_events').iterate()){
        const payload=JSON.parse(String(row.payload)) as Record<string,unknown>;
        if(payload.id!==row.id||payload.timestamp!==row.timestamp||typeof payload.provider!=='string'||!Number.isFinite(payload.timestamp))throw new Error('Archive usage record is invalid');
      }
      this.db.exec('BEGIN IMMEDIATE');
      try{
        this.db.exec('INSERT OR IGNORE INTO main.events SELECT event_id,observed_at,payload FROM archive.events ORDER BY rowid');
        this.db.exec('INSERT OR IGNORE INTO main.observation_signatures SELECT identity,signature FROM archive.observation_signatures');
        this.db.exec('INSERT OR IGNORE INTO main.human_decisions SELECT start_event_id,end_event_id,mode,project_path,decided_at FROM archive.human_decisions');
        this.db.exec('INSERT OR IGNORE INTO main.manual_notes SELECT id,start,end,project,note,created_at FROM archive.manual_notes');
        if(hasUsage){
          this.db.exec('CREATE TABLE IF NOT EXISTS main.usage_events (id TEXT PRIMARY KEY, timestamp REAL NOT NULL, payload TEXT NOT NULL)');
          this.db.exec('INSERT OR IGNORE INTO main.usage_events SELECT id,timestamp,payload FROM archive.usage_events');
        }
        this.db.exec('COMMIT');this.generation++;this.nonEventGeneration++;
      }catch(error){this.db.exec('ROLLBACK');throw error;}
      return {addedEvents:preview.newEvents,addedNotes:preview.newNotes,addedDecisions:preview.newDecisions};
    });
  }
  private previewAttachedArchive(id:string,hasUsage:boolean):ArchivePreview{
    const count=(query:string)=>Number(this.db.prepare(query).get()?.n||0);
    const mainUsage=Boolean(this.db.prepare("SELECT name FROM main.sqlite_master WHERE type='table' AND name='usage_events'").get());
    return {id,archiveEvents:count('SELECT count(*) n FROM archive.events'),
      newEvents:count('SELECT count(*) n FROM archive.events a WHERE NOT EXISTS (SELECT 1 FROM main.events m WHERE m.event_id=a.event_id)'),
      eventConflicts:count('SELECT count(*) n FROM archive.events a JOIN main.events m ON m.event_id=a.event_id WHERE m.payload<>a.payload'),
      newNotes:count('SELECT count(*) n FROM archive.manual_notes a WHERE NOT EXISTS (SELECT 1 FROM main.manual_notes m WHERE m.id=a.id)'),
      noteConflicts:count('SELECT count(*) n FROM archive.manual_notes a JOIN main.manual_notes m ON m.id=a.id WHERE m.start<>a.start OR m.end<>a.end OR m.project<>a.project OR m.note<>a.note'),
      newDecisions:count('SELECT count(*) n FROM archive.human_decisions a WHERE NOT EXISTS (SELECT 1 FROM main.human_decisions m WHERE m.start_event_id=a.start_event_id AND m.end_event_id=a.end_event_id)'),
      decisionConflicts:count('SELECT count(*) n FROM archive.human_decisions a JOIN main.human_decisions m ON m.start_event_id=a.start_event_id AND m.end_event_id=a.end_event_id WHERE m.mode<>a.mode OR m.project_path IS NOT a.project_path'),
      newUsageEvents:hasUsage?mainUsage?count('SELECT count(*) n FROM archive.usage_events a WHERE NOT EXISTS (SELECT 1 FROM main.usage_events m WHERE m.id=a.id)'):count('SELECT count(*) n FROM archive.usage_events'):0,
      usageConflicts:hasUsage&&mainUsage?count('SELECT count(*) n FROM archive.usage_events a JOIN main.usage_events m ON m.id=a.id WHERE m.payload<>a.payload OR m.timestamp<>a.timestamp'):0};
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
