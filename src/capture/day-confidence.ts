import type {Summary} from './events.ts';
import type {SourceSnapshot} from './source-state.ts';

export interface DayConfidenceSource {id:string;name:string;observed:boolean;state:'observed'|'attention'|'waiting'|'off'|'unknown';detail:string;action:SourceSnapshot['action'];}
export interface DayConfidence {sources:DayConfidenceSource[];observed:number;attention:number;waiting:number;caveats:number;}

// A past day is judged from its recorded evidence only. Today's configuration
// and provider trust state must not be projected backwards onto old history.
export function dayConfidence(summary:Summary,sources:SourceSnapshot[],agentIds:string[],from:number,to:number,today:boolean):DayConfidence {
 const intervals=summary.intervals.filter(interval=>interval.end>from&&interval.start<to&&interval.state!=='grouped');
 const agents=new Set(agentIds),tracking=sources.filter(source=>source.id==='macos'||agents.has(source.id));
 const rows=tracking.map(source=>{
  const observed=source.id==='macos'?intervals.some(interval=>interval.state==='human'):
   intervals.some(interval=>interval.provider===source.id&&interval.sourceEventIds.length>0);
  const received=observed||(source.id==='macos'?
   today&&source.lastEvent!==null&&source.lastEvent>=from&&source.lastEvent<to:
   summary.sessions.some(session=>session.provider===source.id&&session.lastObservedAt>=from&&session.lastObservedAt<to));
  const needsRepair=today&&['repair-needed','failed','stale'].includes(source.state);
  const off=today&&['off','paused','unavailable','excluded'].includes(source.state);
  const waiting=today&&['waiting','verified','permission-limited'].includes(source.state)&&!observed;
  const state=needsRepair?'attention':off?'off':waiting?'waiting':observed?'observed':today?'waiting':'unknown';
  const detail=needsRepair?source.detail:today&&source.state==='verified'?'Current hook runtime delivered an event earlier; no activity is credited on this day':
   observed?'Credited activity recorded on this day':received?'Event received, but no duration credited on this day':today?source.detail:'No credited activity recorded on this day';
  return {id:source.id,name:source.name,observed,state,detail,action:today?source.action:'none'} as DayConfidenceSource;
 });
 const caveats=[...summary.coverage,...summary.unresolved].filter(issue=>issue.observedAt!==undefined&&issue.observedAt>=from&&issue.observedAt<to).length;
 return {sources:rows,observed:rows.filter(row=>row.observed).length,attention:rows.filter(row=>row.state==='attention').length,waiting:rows.filter(row=>row.state==='waiting').length,caveats};
}
