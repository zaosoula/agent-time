import type {DatabaseSync} from 'node:sqlite';
import type {CaptureEvent} from './events.ts';

/**
 * Bounded reads for one summary window.
 *
 * Agent evidence (hooks, Orca workers, fences) can matter long before a window:
 * a turn or tool that started yesterday still credits time today. Mac activity
 * only pairs with a neighbour at most `maxGap` (15 s) away. So the window reads
 * agent evidence from a day plus the agent idle threshold before it, but Mac
 * activity samples only from a short margin around it. That keeps the read
 * close to one day of samples no matter how long the history is.
 */
export const agentLookbackSeconds=86400;
export const activityMarginSeconds=60;
export function windowBounds(from:number,to:number,agentIdleThreshold:number){
 return {
  readFrom:from-agentLookbackSeconds-agentIdleThreshold,
  activityFrom:from-activityMarginSeconds,
  activityTo:to+activityMarginSeconds,
  // Closing evidence (tool end, response stop) after the window still shapes
  // the intervals inside it: a turn can stay open for hours.
  readTo:to+agentLookbackSeconds+agentIdleThreshold,
 };
}
export type WindowBounds=ReturnType<typeof windowBounds>;
export function inWindow(event:CaptureEvent,bounds:WindowBounds):boolean{
 if(event.observedAt<bounds.readFrom||event.observedAt>=bounds.readTo)return false;
 return !isActivitySample(event)||event.observedAt>=bounds.activityFrom&&event.observedAt<bounds.activityTo;
}
export function isActivitySample(event:CaptureEvent):boolean{return event.source==='macos'&&event.kind==='activity';}

const identityFields=['source','kind','hostId','workspaceId','sessionId','agentId','dispatchId','terminalHandle','terminalIncarnation','provider','runId','taskId','cwd'] as const;
const detailFields=['foregroundBundleId','foregroundName','browserDomain','state','outcome','toolName','hook'] as const;
/** Parse event rows, sharing repeated identity strings to keep large windows small in memory. */
export function eventParser(){
 const pooled=new Map<string,string>();
 const intern=(value:unknown)=>{
  if(typeof value!=='string')return value;
  const previous=pooled.get(value);if(previous!==undefined)return previous;
  pooled.set(value,value);return value;
 };
 return (payload:string):CaptureEvent=>{
  const event=JSON.parse(payload) as CaptureEvent;
  for(const key of identityFields)if(typeof event[key]==='string')(event as unknown as Record<string,unknown>)[key]=intern(event[key]);
  if(typeof event.collectorEpoch==='string')event.collectorEpoch=intern(event.collectorEpoch) as string;
  if(event.data)for(const key of detailFields)if(typeof event.data[key]==='string')event.data[key]=intern(event.data[key]);
  return event;
 };
}
const windowQuery="SELECT rowid,payload FROM events WHERE observed_at>=? AND observed_at<? AND (observed_at>=? AND observed_at<? OR json_extract(payload,'$.kind')<>'activity' OR json_extract(payload,'$.source')<>'macos') ORDER BY rowid";
/** Events relevant to [from,to), in insertion order, with the rowid of the newest one. */
export function readWindowEvents(db:DatabaseSync,from:number,to:number,agentIdleThreshold:number):{events:CaptureEvent[];bounds:WindowBounds}{
 const bounds=windowBounds(from,to,agentIdleThreshold),parse=eventParser(),events:CaptureEvent[]=[];
 if(Number(db.prepare('PRAGMA user_version').get()?.user_version)===2){
  // Filter/sort only metadata first. Decoding inside a timestamp-index scan or
  // SQLite sorter would defeat the bounded cache on interleaved event clocks.
  const rows=db.prepare('SELECT rowid FROM events WHERE observed_at>=? AND observed_at<? AND (observed_at>=? AND observed_at<? OR activity_sample=0) ORDER BY rowid');
  const read=db.prepare('SELECT payload FROM events WHERE rowid=?');
  for(const row of rows.iterate(bounds.readFrom,bounds.readTo,bounds.activityFrom,bounds.activityTo))events.push(parse(String(read.get(row.rowid!)!.payload)));
 }else for(const row of db.prepare(windowQuery).iterate(bounds.readFrom,bounds.readTo,bounds.activityFrom,bounds.activityTo))events.push(parse(String(row.payload)));
 return {events,bounds};
}
export function localDayBounds(date:string):{from:number;to:number}{
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new Error('Invalid summary date');
 const start=new Date(`${date}T00:00:00`);
 if(Number.isNaN(start.getTime())||localDate(start.getTime()/1000)!==date)throw new Error('Invalid summary date');
 const end=new Date(start);end.setDate(end.getDate()+1);
 return {from:start.getTime()/1000,to:end.getTime()/1000};
}
export function localDate(seconds:number):string{
 const d=new Date(seconds*1000);
 return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
export function addDays(date:string,days:number):string{
 const d=new Date(`${date}T00:00:00`);d.setDate(d.getDate()+days);return localDate(d.getTime()/1000);
}
