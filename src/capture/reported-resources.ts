import type {CaptureEvent,Summary} from './events.ts';
import {resolveProjectPath} from './project-path.ts';

export const resourceKinds=['artifact','pull_request','issue','deployment','preview','document','other'] as const;
export interface ReportedResource {url:string;projectPath:string;title?:string;kind?:string;provider?:string;observedAt:number;}

/** The page a resource lives at: origin and path, without query, fragment or trailing slash. */
export function resourceKey(raw:string):string|null{
 try{
  const url=new URL(raw);
  if(!['http:','https:'].includes(url.protocol))return null;
  return url.origin.toLowerCase()+(url.pathname.replace(/\/+$/,'')||'');
 }catch{return null;}
}
/** Project root for a workspace ID or path; Orca worktrees count as their repository. */
function projectOf(value:unknown,hostId?:string):string|undefined{
 const raw=typeof value==='string'?value.split('::').at(-1):undefined;
 return raw?.startsWith('/')?resolveProjectPath(raw,{hostId}):undefined;
}
/** Resources agents reported, by page; the latest report for a page wins. */
export function reportedResources(events:CaptureEvent[]):Map<string,ReportedResource>{
 const resources=new Map<string,ReportedResource>();
 for(const event of [...events].sort((a,b)=>a.observedAt-b.observedAt)){
  if(event.source!=='agent_report'||event.kind!=='resource'||typeof event.data?.url!=='string')continue;
  const canonical=event.projectPath?.startsWith('/')?event.projectPath.replace(/\/+$/,'')||'/':undefined;
  const key=resourceKey(event.data.url),projectPath=canonical||projectOf(event.workspaceId,event.hostId)||projectOf(event.data.project,event.hostId);
  if(!key||!projectPath)continue;
  resources.set(key,{url:event.data.url,projectPath,title:typeof event.data.title==='string'?event.data.title:undefined,kind:typeof event.data.resourceKind==='string'?event.data.resourceKind:undefined,provider:event.provider,observedAt:event.observedAt});
 }
 return resources;
}
/**
 * Attribute browser time on a page an agent reported to that agent's project.
 * Applies to time before and after the report. Review decisions and user
 * website rules stay authoritative.
 */
export function applyReportedResources(summary:Summary,resources:Map<string,ReportedResource>):Summary{
 if(!resources.size)return summary;
 let changed=false;
 const intervals=summary.intervals.map(interval=>{
  if(interval.state!=='human'||!interval.browserUrl||interval.userAttribution||interval.attributionSource==='rule')return interval;
  const key=resourceKey(interval.browserUrl),resource=key?resources.get(key):undefined;
  if(!resource)return interval;
  changed=true;
  return {...interval,workspaceId:`resource::${resource.projectPath}`,projectPath:resource.projectPath,attributionSource:'agent_resource',
   attributionReason:`${resource.provider||'An agent'} reported ${resource.title?`“${resource.title}”`:'this page'}${resource.kind?` (${resource.kind.replace('_',' ')})`:''}`};
 });
 return changed?{...summary,intervals}:summary;
}
