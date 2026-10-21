import type {CaptureEvent} from './events.ts';

const settled=new Set(['succeeded','failed','completed','cancelled','abandoned']);
export const staticOrcaScopeReason='Only this Orca host is observed; remote execution has not been verified';

export function observationKey(event:CaptureEvent):string|null {
 if(event.source==='orca'&&event.kind==='coverage'&&event.data?.reason===staticOrcaScopeReason)
  return JSON.stringify(['orca-host-scope',new Date(event.observedAt*1000).toISOString().slice(0,10)]);
 if(event.source!=='orca'||!event.hostId)return null;
 if(event.kind==='worker'&&event.dispatchId&&settled.has(String(event.data?.outcome))&&event.data?.fresh!==true)
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
 const keep=new Set<number>(),latest=new Map<string,{rowid:number;signature:string}>();
 for(const {rowid,event} of rows){
  const key=observationKey(event);
  if(!key){keep.add(rowid);continue;}
  const signature=observationSignature(event),previous=latest.get(key);
  if(!previous||previous.signature!==signature){if(previous)keep.add(previous.rowid);keep.add(rowid);}
  latest.set(key,{rowid,signature});
 }
 for(const last of latest.values())keep.add(last.rowid);
 return keep;
}
