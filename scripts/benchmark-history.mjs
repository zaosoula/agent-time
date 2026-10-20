import {DatabaseSync} from 'node:sqlite';
import {performance} from 'node:perf_hooks';
import {statSync} from 'node:fs';
import {summarize} from '../src/capture/correlate.ts';
import {summaryForDate} from '../src/capture/daily.ts';
const path=process.argv[2];
if(!path)throw new Error('Usage: node scripts/benchmark-history.mjs /path/to/events.sqlite');
const db=new DatabaseSync(path,{readOnly:true});
try{
 db.exec('BEGIN'); // Keep full and bounded comparisons on one SQLite snapshot.
 const sizeBytes=statSync(path).size;
 const count=Number(db.prepare('SELECT COUNT(*) count FROM events').get().count);
 const settingsAt=performance.now();
 const startupRows=db.prepare("SELECT payload FROM events WHERE json_extract(payload,'$.source')='capture' ORDER BY rowid").all();
 const settingsReadMs=Math.round(performance.now()-settingsAt);
 const start=performance.now();
 let bytes=0;
 const events=[];
 for(const row of db.prepare('SELECT payload FROM events ORDER BY rowid').iterate()){bytes+=String(row.payload).length;events.push(JSON.parse(String(row.payload)));}
 const fullScanMs=Math.round(performance.now()-start);
 const summarizeStart=performance.now();
 const summary=summarize(events,{idleThreshold:300,agentIdleThreshold:300});
 const summarizeMs=Math.round(performance.now()-summarizeStart);
 const latest=Number(db.prepare('SELECT MAX(observed_at) time FROM events').get().time||0);
 const dayStart=process.argv[3]?new Date(process.argv[3]+'T00:00:00'):new Date(latest*1000);dayStart.setHours(0,0,0,0);
 const dayEnd=new Date(dayStart);dayEnd.setDate(dayEnd.getDate()+1);
 const from=dayStart.getTime()/1000,to=dayEnd.getTime()/1000;
 const dayStartAt=performance.now();
 const rows=Number(db.prepare('SELECT COUNT(*) count FROM events WHERE observed_at>=? AND observed_at<?').get(from,to).count);
 const dayCountMs=Math.round(performance.now()-dayStartAt);
 const date=`${dayStart.getFullYear()}-${String(dayStart.getMonth()+1).padStart(2,'0')}-${String(dayStart.getDate()).padStart(2,'0')}`;
 const windowStart=from-86400,windowEnd=to+86400;
 const windowReadStart=performance.now();
 const windowEvents=db.prepare('SELECT payload FROM events WHERE observed_at>=? AND observed_at<? ORDER BY rowid').all(windowStart,windowEnd).map(row=>JSON.parse(String(row.payload)));
 const windowReadMs=Math.round(performance.now()-windowReadStart);
 const windowSummarizeStart=performance.now();
 const windowSummary=summaryForDate(summarize(windowEvents,{idleThreshold:300,agentIdleThreshold:300}),date);
 const windowSummarizeMs=Math.round(performance.now()-windowSummarizeStart);
 const fullDay=summaryForDate(summary,date);
 const signature=day=>new Set(day.intervals.map(i=>JSON.stringify([i.start,i.end,i.state,i.proof,i.sourceEventIds,i.sessionId,i.agentId,i.dispatchId,i.workspaceId])));
 const fullIntervals=signature(fullDay),windowIntervals=signature(windowSummary);
 console.log(JSON.stringify({databaseBytes:sizeBytes,events:count,startupCaptureRows:startupRows.length,settingsReadMs,fullScanMs,summarizeMs,intervals:summary.intervals.length,heapUsedBytes:process.memoryUsage().heapUsed,scannedPayloadBytes:bytes,latestDayEvents:rows,dayCountMs,window:{events:windowEvents.length,readMs:windowReadMs,summarizeMs:windowSummarizeMs,missingIntervals:[...fullIntervals].filter(i=>!windowIntervals.has(i)).length,extraIntervals:[...windowIntervals].filter(i=>!fullIntervals.has(i)).length,extraKinds:[...windowIntervals].filter(i=>!fullIntervals.has(i)).map(i=>JSON.parse(i)[2]),fullTotals:{human:fullDay.humanSeconds,agent:fullDay.agentSeconds,elapsed:fullDay.elapsedSeconds},windowTotals:{human:windowSummary.humanSeconds,agent:windowSummary.agentSeconds,elapsed:windowSummary.elapsedSeconds}}},null,2));
}finally{db.exec('ROLLBACK');db.close();}
