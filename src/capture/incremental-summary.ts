import type {CaptureEvent,Summary} from './events.ts';
import {minuteCreditSeconds,summarize} from './correlate.ts';

// Activity samples are the only events whose intervals can be appended without
// changing session identity, capture fences, or agent credit. Any other event
// sends the collector through its full replay path.
export function appendActivitySummary(summary:Summary,previous:CaptureEvent|undefined,events:CaptureEvent[],idleThreshold:number):Summary|null {
 if(!events.length||events.some(event=>event.source!=='macos'||event.kind!=='activity'))return null;
 const delta=summarize(previous?[previous,...events]:events,{idleThreshold});
 if(delta.coverage.length||delta.unresolved.length||delta.intervals.some(interval=>interval.state!=='human'))return null;
 const firstGrouped=summary.intervals.findIndex(interval=>interval.state==='grouped');
 const intervals=firstGrouped<0?[...summary.intervals,...delta.intervals]:[
  ...summary.intervals.slice(0,firstGrouped),...delta.intervals,...summary.intervals.slice(firstGrouped),
 ];
 const human=intervals.filter(interval=>interval.state==='human').map(interval=>[interval.start,interval.end] as [number,number]);
 const grouped=intervals.filter(interval=>interval.state==='grouped').map(interval=>[interval.start,interval.end] as [number,number]);
 return {...summary,intervals,humanSeconds:minuteCreditSeconds(human),elapsedSeconds:minuteCreditSeconds([...grouped,...human])};
}
