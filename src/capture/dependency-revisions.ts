import type{DatabaseSync}from'node:sqlite';
import{randomUUID}from'node:crypto';
import type{WindowBounds}from'./summary-window.ts';

/** Tiny transactional revisions. Writers maintain these even from another process.
 * Existing evidence needs no scan: a fresh identity names that initial snapshot. */
export function ensureDependencyRevisions(db:DatabaseSync,packed:boolean){
 const sample=packed?'NEW.activity_sample':"(json_extract(NEW.payload,'$.source')='macos' AND json_extract(NEW.payload,'$.kind')='activity')";
 db.exec(`CREATE TABLE IF NOT EXISTS at_dependency_revision(id INTEGER PRIMARY KEY,identity TEXT NOT NULL,resources INTEGER NOT NULL,reports INTEGER NOT NULL,review INTEGER NOT NULL,mutations INTEGER NOT NULL,terminals INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS at_evidence_buckets(bucket INTEGER NOT NULL,kind TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(bucket,kind)) WITHOUT ROWID;`);
 db.prepare('INSERT OR IGNORE INTO at_dependency_revision VALUES(1,?,0,0,0,0,0)').run(randomUUID());
 const source=packed?'NEW.source':"json_extract(NEW.payload,'$.source')",kind="json_extract(NEW.payload,'$.kind')";
 db.exec(`CREATE TRIGGER IF NOT EXISTS at_dependency_insert AFTER INSERT ON events BEGIN
  INSERT INTO at_evidence_buckets VALUES(CAST(floor(NEW.observed_at/86400) AS INTEGER),CASE WHEN ${sample} THEN 'sample' ELSE 'other' END,1) ON CONFLICT(bucket,kind) DO UPDATE SET revision=revision+1;
  UPDATE at_dependency_revision SET resources=resources+CASE WHEN ${source}='agent_report' AND ${kind}='resource' THEN 1 ELSE 0 END,reports=reports+CASE WHEN ${source}='agent_report' OR ${kind}='session_end' THEN 1 ELSE 0 END,terminals=terminals+CASE WHEN ${kind}='terminal' THEN 1 ELSE 0 END WHERE id=1 AND (${source}='agent_report' OR ${kind} IN ('session_end','terminal'));
 END;
 CREATE TRIGGER IF NOT EXISTS at_dependency_replace BEFORE INSERT ON events WHEN EXISTS(SELECT 1 FROM events WHERE event_id=NEW.event_id OR rowid=NEW.rowid) BEGIN UPDATE at_dependency_revision SET mutations=mutations+1 WHERE id=1; END;
 CREATE TRIGGER IF NOT EXISTS at_dependency_update AFTER UPDATE ON events BEGIN UPDATE at_dependency_revision SET mutations=mutations+1 WHERE id=1; END;
 CREATE TRIGGER IF NOT EXISTS at_dependency_delete AFTER DELETE ON events BEGIN UPDATE at_dependency_revision SET mutations=mutations+1 WHERE id=1; END;`);
 for(const table of ['human_decisions','human_splits','agent_time_exclusions'])for(const action of ['INSERT','UPDATE','DELETE'])db.exec(`CREATE TRIGGER IF NOT EXISTS at_dependency_${table}_${action.toLowerCase()} AFTER ${action} ON ${table} BEGIN UPDATE at_dependency_revision SET review=review+1 WHERE id=1; END;`);
 if(packed)for(const action of ['INSERT','UPDATE','DELETE'])db.exec(`CREATE TRIGGER IF NOT EXISTS at_dependency_blocks_${action.toLowerCase()} AFTER ${action} ON at_event_blocks BEGIN UPDATE at_dependency_revision SET mutations=mutations+1 WHERE id=1; END;`);
}
export function dependencyRevision(db:DatabaseSync,scope:'resources'|'reports'|'review'|'mutations'):string{
 const row=db.prepare(`SELECT identity,${scope} revision,mutations FROM at_dependency_revision WHERE id=1`).get();if(!row)throw Error('Missing dependency revision');
 return JSON.stringify([row.identity,row.revision,scope==='review'?0:row.mutations]);
}
/** UTC buckets conservatively include their whole day; no decoding/counting of observations. */
export function evidenceWindowRevision(db:DatabaseSync,bounds:WindowBounds):string{
 const row=db.prepare('SELECT identity,mutations,terminals FROM at_dependency_revision WHERE id=1').get();if(!row)throw Error('Missing dependency revision');
 const buckets=db.prepare("SELECT bucket,kind,revision FROM at_evidence_buckets WHERE kind='sample' AND bucket BETWEEN ? AND ? OR kind='other' AND bucket BETWEEN ? AND ? ORDER BY bucket,kind").all(Math.floor(bounds.activityFrom/86400),Math.floor(bounds.activityTo/86400),Math.floor(bounds.readFrom/86400),Math.floor(bounds.readTo/86400));
 return JSON.stringify([row,buckets]);
}
