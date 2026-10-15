export interface TimeRange { start:number; end:number }

export const minimumTimelineSpan=60;

export function clampTimeRange(range:TimeRange,dayStart:number,dayEnd:number,minSpan=minimumTimelineSpan):TimeRange{
 const daySpan=dayEnd-dayStart;
 const span=Math.min(daySpan,Math.max(minSpan,range.end-range.start));
 const start=Math.max(dayStart,Math.min(dayEnd-span,range.start));
 return {start,end:start+span};
}

export function zoomTimeRange(range:TimeRange,anchor:number,factor:number,dayStart:number,dayEnd:number):TimeRange{
 const span=Math.min(dayEnd-dayStart,Math.max(minimumTimelineSpan,(range.end-range.start)*factor));
 const ratio=Math.max(0,Math.min(1,(anchor-range.start)/(range.end-range.start)));
 return clampTimeRange({start:anchor-ratio*span,end:anchor+(1-ratio)*span},dayStart,dayEnd);
}

export function panTimeRange(range:TimeRange,seconds:number,dayStart:number,dayEnd:number):TimeRange{
 return clampTimeRange({start:range.start+seconds,end:range.end+seconds},dayStart,dayEnd);
}

export interface TimelineTick { time:number; major:boolean }

export function timelineTicks(range:TimeRange):TimelineTick[]{
 const span=range.end-range.start;
 const [minor,major]=span<=2*60?[2,10]:span<=5*60?[10,30]:span<=15*60?[15,60]:span<=60*60?[60,5*60]:span<=3*60*60?[5*60,15*60]:span<=6*60*60?[10*60,30*60]:span<=12*60*60?[15*60,60*60]:[30*60,2*60*60];
 const first=Math.ceil(range.start/minor)*minor;
 const ticks:TimelineTick[]=[];
 for(let time=first;time<=range.end;time+=minor)ticks.push({time,major:time%major===0});
 return ticks;
}
