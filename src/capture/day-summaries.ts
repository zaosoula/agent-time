import type {EventStore} from './store.ts';
import type {CaptureEvent,Summary} from './events.ts';
import {summarize} from './correlate.ts';
import {appendActivitySummary} from './incremental-summary.ts';
import {inWindow,isActivitySample,localDayBounds,type WindowBounds} from './summary-window.ts';

export interface SummaryOptions {idleThreshold:number;agentIdleThreshold:number;}
export interface DayWindow {
 date:string;from:number;to:number;bounds:WindowBounds;
 /** Reducer output for the bounded window, before review decisions; intervals are not clipped to the day. */
 raw:Summary;
 /** Changes whenever `raw` changes. */
 version:number;
 lastActivity?:CaptureEvent;maxObservedAt:number;checkedAt:number;
}
// Beyond this many unseen rows a recompute on demand is cheaper than replaying them.
const maxSyncRows=20_000;
// Enough for a review week plus its backlog; a busy day's window can hold several MB.
const maxCachedDays=16;

/**
 * Per-day summaries over bounded windows, so a day costs about one day of
 * events however long the history grows. New rows only touch the days whose
 * window they fall into: Mac activity samples append in place, anything else
 * drops that day for a recompute on its next read. Closed days stay cached.
 */
export class DaySummaries {
 private entries=new Map<string,DayWindow>();
 private seenRowid:number|undefined;
 private version=0;
 private store:EventStore;private options:()=>SummaryOptions;
 /** Number of full window computations, for tests and diagnostics. */
 computations=0;
 constructor(store:EventStore,options:()=>SummaryOptions){this.store=store;this.options=options;}
 invalidate(){this.entries.clear();this.seenRowid=undefined;}
 window(date:string,maxAgeMs=0):DayWindow{
  const now=Date.now(),cached=this.entries.get(date);
  if(cached&&maxAgeMs>0&&now-cached.checkedAt<maxAgeMs)return cached;
  this.sync();
  let entry=this.entries.get(date);
  if(!entry)entry=this.compute(date);
  else{this.entries.delete(date);this.entries.set(date,entry);}
  entry.checkedAt=now;
  return entry;
 }
 private sync(){
  const last=this.store.lastEventRowid();
  if(this.seenRowid===undefined||!this.entries.size||last<this.seenRowid||last-this.seenRowid>maxSyncRows){
   if(this.seenRowid!==undefined&&(last<this.seenRowid||last-this.seenRowid>maxSyncRows))this.entries.clear();
   this.seenRowid=last;return;
  }
  if(last===this.seenRowid)return;
  const rows=this.store.eventsAfterRowid(this.seenRowid);
  this.seenRowid=Math.max(last,rows.at(-1)?.rowid??last);
  const events=rows.map(row=>row.event),idleThreshold=this.options().idleThreshold;
  for(const [date,entry] of [...this.entries]){
   const relevant=events.filter(event=>inWindow(event,entry.bounds));
   if(!relevant.length)continue;
   const ordered=relevant.every((event,index)=>isActivitySample(event)&&event.observedAt>=(index?relevant[index-1]!.observedAt:entry.maxObservedAt));
   const value=ordered?appendActivitySummary(entry.raw,entry.lastActivity,relevant,idleThreshold):null;
   if(!value){this.entries.delete(date);continue;}
   entry.raw=value;entry.lastActivity=relevant.at(-1);entry.maxObservedAt=relevant.at(-1)!.observedAt;entry.version=++this.version;
  }
 }
 private compute(date:string):DayWindow{
  const {from,to}=localDayBounds(date),{idleThreshold,agentIdleThreshold}=this.options();
  const {events,bounds}=this.store.windowEvents(from,to,agentIdleThreshold);
  this.computations++;
  const raw=summarize(events,{idleThreshold,agentIdleThreshold,alreadyUnique:true});
  applyTerminalTitles(raw,events,handles=>this.store.latestTerminals(handles));
  let lastActivity:CaptureEvent|undefined,maxObservedAt=-Infinity;
  for(const event of events){
   maxObservedAt=Math.max(maxObservedAt,event.observedAt);
   if(isActivitySample(event))lastActivity=event;
   else if(resetsActivity(event))lastActivity=undefined;
  }
  const entry:DayWindow={date,from,to,bounds,raw,version:++this.version,lastActivity,maxObservedAt,checkedAt:Date.now()};
  this.entries.set(date,entry);
  while(this.entries.size>maxCachedDays)this.entries.delete(this.entries.keys().next().value!);
  return entry;
 }
}
export function resetsActivity(event:CaptureEvent):boolean{
 if(['sleep','capture_stop','capture_start'].includes(event.kind))return true;
 if(event.kind!=='capture_settings')return false;
 const previous=event.data?.previous as Record<string,unknown>|undefined,next=event.data?.surfaces as Record<string,unknown>|undefined;
 return Boolean(previous&&next&&previous.macosActivity!==next.macosActivity);
}
/** Orca terminal titles and paths name agent sessions; the newest observation wins. */
export function applyTerminalTitles(summary:Summary,events:CaptureEvent[],lookup?:(handles:string[])=>CaptureEvent[]):void{
 const terminals=new Map<string|undefined,CaptureEvent>();
 for(const event of events)if(event.kind==='terminal')terminals.set(event.terminalHandle,event);
 if(lookup){
  // Terminal observations are stored only when they change, so a window can
  // miss the one that names a long-lived terminal.
  const missing=[...new Set(summary.sessions.filter(s=>!s.child&&s.terminalHandle&&!terminals.has(s.terminalHandle)).map(s=>s.terminalHandle!))];
  if(missing.length)for(const event of lookup(missing))terminals.set(event.terminalHandle,event);
 }
 for(const s of summary.sessions){
  const t=terminals.get(s.terminalHandle);
  if(t&&!s.child){s.title=String(t.data?.title||s.title).replace(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✳◐◓◑◒]\s*/, '');s.cwd=t.cwd||s.cwd;}
 }
}
