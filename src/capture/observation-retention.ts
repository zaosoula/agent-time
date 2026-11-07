import type {CaptureEvent} from './events.ts';

// Imported by the UI through correlate.ts: keep this module free of Node and Orca CLI imports.
const settled=new Set(['succeeded','failed','completed','cancelled','abandoned']);
export const staticOrcaScopeReason='Only this Orca host is observed; remote execution has not been verified';

/**
 * Unchanged live-worker snapshots are rewritten at most this often. The row
 * keeps a session's last-seen time current and lets hooks link to the worker
 * (see `workerSnapshotValidSeconds`); every poll in between added nothing.
 */
export const workerHeartbeatSeconds=300;
/** How long a non-fresh worker snapshot describes its terminal: one heartbeat plus poll slack. */
export const workerSnapshotValidSeconds=workerHeartbeatSeconds+45;
/** Whether an unchanged observation must still be written periodically. */
export function needsHeartbeat(event:CaptureEvent):boolean{
 return event.source==='orca'&&event.kind==='worker'&&!settled.has(String(event.data?.outcome));
}
export function observationKey(event:CaptureEvent):string|null {
 if(event.source==='orca'&&event.kind==='coverage'&&event.data?.reason===staticOrcaScopeReason)
  return JSON.stringify(['orca-host-scope',new Date(event.observedAt*1000).toISOString().slice(0,10)]);
 if(event.source!=='orca'||!event.hostId)return null;
// Fresh snapshots are kept every poll: two of them at most 15 s apart are what
 // credits Orca agent time. Others only change state or confirm presence.
 if(event.kind==='worker'&&event.dispatchId&&event.data?.fresh!==true)
  return JSON.stringify(['worker',event.hostId,event.dispatchId]);
 if(event.kind==='terminal'&&event.terminalHandle)
  return JSON.stringify(['terminal',event.hostId,event.terminalHandle,event.terminalIncarnation]);
 return null;
}

export function observationSignature(event:CaptureEvent):string {
 const {eventId,observedAt,monotonicAt,collectorEpoch,sourceAt,...state}=event;
 return JSON.stringify(state);
}

// Keep the first and last row in each unchanged run. The final row preserves
// historical last-observed timestamps during a review-copy migration.
export function retainedObservationRows(rows:Array<{rowid:number;event:CaptureEvent}>):Set<number> {
 const keep=new Set<number>(),latest=new Map<string,{rowid:number;signature:string}>(),beat=new Map<string,number>();
 for(const {rowid,event} of rows){
  // Snapshots live capture no longer stores (see informativeWorker) are dropped.
  if(event.source==='orca'&&event.kind==='worker'&&!informativeWorker(event))continue;
  const key=observationKey(event);
  if(!key){keep.add(rowid);continue;}
  const signature=observationSignature(event),previous=latest.get(key);
  if(!previous||previous.signature!==signature){if(previous)keep.add(previous.rowid);keep.add(rowid);beat.set(key,event.observedAt);}
  // Keep the same heartbeat rows live capture writes.
  else if(needsHeartbeat(event)&&event.observedAt-(beat.get(key)??-Infinity)>=workerHeartbeatSeconds){keep.add(rowid);beat.set(key,event.observedAt);}
  latest.set(key,{rowid,signature});
 }
 for(const last of latest.values())keep.add(last.rowid);
 return keep;
}
/**
 * Whether a worker snapshot can affect a summary. A snapshot that is not fresh
 * credits no time; without a host and terminal it cannot link a hook to its
 * dispatch; without a final outcome it closes nothing. Such snapshots were
 * most of the event store (one row per old dispatch every 30 s) and are skipped.
 */
export function informativeWorker(event:CaptureEvent):boolean{
 return event.data?.fresh===true||Boolean(event.hostId)||settled.has(String(event.data?.outcome));
}
