import type {Interval,Summary} from './events.ts';
import {intervalProjectPath} from './human-review.ts';
export interface ActivityFilters {search:string;app:string;site:string;device:string;assignment:'all'|'assigned'|'unassigned';}
export const emptyActivityFilters=():ActivityFilters=>({search:'',app:'',site:'',device:'',assignment:'all'});
export function matchesActivity(interval:Interval,filters:ActivityFilters,sessionText=''){
 if((filters.app||filters.site)&&interval.state!=='human')return false;
 const app=interval.foregroundName||interval.browserBundleId||interval.foregroundBundleId||'';
 const assigned=Boolean(intervalProjectPath(interval))&&(interval.userAttribution==='assigned'||interval.attributionSource!=='conflict');
 return (!filters.app||app===filters.app)&&(!filters.site||interval.browserDomain===filters.site)&&(!filters.device||(interval.hostId||'local')===filters.device)&&
  (filters.assignment==='all'||interval.state==='human'&&(filters.assignment==='assigned'?assigned:!assigned))&&
  (!filters.search.trim()||[app,interval.browserDomain,interval.browserUrl,interval.browserTitle,interval.tabTitle,interval.workspaceId,interval.projectPath,interval.provider,sessionText].join(' ').toLocaleLowerCase().includes(filters.search.trim().toLocaleLowerCase()));
}
export function filterActivity(summary:Summary,filters:ActivityFilters,project='all'):Interval[]{
 if(project==='all'&&Object.values(filters).every(value=>!value||value==='all'))return summary.intervals;
 const sessions=new Map(summary.sessions.map(s=>[JSON.stringify([s.hostId||'local',s.provider||'',s.sessionId||'',s.agentId||'']),s]));
 return summary.intervals.filter(interval=>{
  const session=sessions.get(JSON.stringify([interval.hostId||'local',interval.provider||'',interval.sessionId||'',interval.agentId||'']));
  const path=(interval.state==='human'&&interval.attributionSource==='conflict'&&interval.userAttribution!=='assigned'?undefined:intervalProjectPath(interval))||(interval.state!=='human'&&session?intervalProjectPath({...session,workspaceId:session.workspaceId||session.cwd}):undefined);
  return (project==='all'||(project==='unassigned'?!path:path===project))&&matchesActivity(interval,filters,session?.title);
 });
}
