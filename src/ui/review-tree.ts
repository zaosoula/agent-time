import {projectDisplay} from './project-identity.ts';
import {preciseClock} from './format.ts';
import {reviewIsAssigned,reviewAssignmentLabel,reviewContextTitle,reviewGroupId,reviewVisitTitle,type AppReviewGroup} from './review-apps.ts';

export interface ReviewNode {
  key:string;
  label:string;
  description?:string;
  kind:'project'|'app'|'site'|'context'|'visit'|'short';
  groups:AppReviewGroup[];
  seconds:number;
  children:ReviewNode[];
}

const trackingParameters=new Set(['fbclid','gclid','dclid','msclkid','mc_cid','mc_eid','_ga','_gl','yclid','igshid']);
function website(group:AppReviewGroup):{domain:string;page:string}|undefined{
  try{
    const url=new URL(group.browserUrl||group.browserOrigin||'');
    if(url.protocol!=='https:'&&url.protocol!=='http:')return;
    for(const key of [...url.searchParams.keys()])if(key.toLowerCase().startsWith('utm_')||trackingParameters.has(key.toLowerCase()))url.searchParams.delete(key);
    return {domain:url.hostname,page:url.href};
  }catch{
    if(group.browserDomain)return {domain:group.browserDomain.toLowerCase(),page:''};
  }
}
const key=(kind:ReviewNode['kind'],parent:string,identity:string)=>JSON.stringify([kind,parent,identity]);
const orderedGroups=(groups:AppReviewGroup[])=>[...groups].sort((a,b)=>a.start-b.start||a.end-b.end||reviewGroupId(a).localeCompare(reviewGroupId(b)));
const ordered=(nodes:ReviewNode[])=>nodes.sort((a,b)=>b.seconds-a.seconds||a.label.localeCompare(b.label)||a.key.localeCompare(b.key));
function assignment(groups:AppReviewGroup[]):string{
  // Compare complete paths as two different projects can have the same basename.
  const identities=new Set(groups.map(group=>JSON.stringify([group.projectPath||'',group.userAttribution||'',group.attributionSource==='conflict'])));
  return identities.size>1?'Mixed assignments':reviewAssignmentLabel(groups[0]!);
}
function node(kind:ReviewNode['kind'],nodeKey:string,label:string,groups:AppReviewGroup[],children:ReviewNode[]=[],detail?:string):ReviewNode{
  return {key:nodeKey,label,kind,groups:orderedGroups(groups),seconds:groups.reduce((sum,group)=>sum+group.seconds,0),children:ordered(children),description:[detail,assignment(groups)].filter(Boolean).join(' · ')};
}
function visits(groups:AppReviewGroup[],parent:string):ReviewNode[]{
  const leaves=groups.map(group=>node('visit',key('visit',parent,reviewGroupId(group)),reviewVisitTitle(group),[group],[],`${preciseClock(group.start)}–${preciseClock(group.end)}${group.browserUrl?' · '+group.browserUrl:''}`));
  const short=leaves.filter(leaf=>leaf.seconds<15),regular=leaves.filter(leaf=>leaf.seconds>=15);
  if(short.length)regular.push(node('short',key('short',parent,'under-15s'),'Short activities',short.flatMap(leaf=>leaf.groups),short));
  return ordered(regular);
}
function buckets(groups:AppReviewGroup[],identity:(group:AppReviewGroup)=>string):Map<string,AppReviewGroup[]>{
  const result=new Map<string,AppReviewGroup[]>();
  for(const group of groups){const id=identity(group),bucket=result.get(id);if(bucket)bucket.push(group);else result.set(id,[group]);}
  return result;
}
function contextLabel(groups:AppReviewGroup[]):string{
  // Titles can change between visits to one URL; pick consistently, independent
  // of input order. Original labels remain visible on individual visits.
  return [...new Set(groups.map(reviewContextTitle))].sort((a,b)=>a.localeCompare(b))[0]!;
}
function appChildren(groups:AppReviewGroup[],parent:string):ReviewNode[]{
  const sites=new Map<string,AppReviewGroup[]>(),native:AppReviewGroup[]=[];
  for(const group of groups){const site=website(group);if(site){const bucket=sites.get(site.domain);if(bucket)bucket.push(group);else sites.set(site.domain,[group]);}else native.push(group);}
  const result:ReviewNode[]=[];
  for(const [domain,siteGroups] of sites){
    const siteKey=key('site',parent,domain),contexts:ReviewNode[]=[];
    for(const [page,pageGroups] of buckets(siteGroups,group=>website(group)!.page)){
      const contextKey=key('context',siteKey,page||'unknown-page');
      contexts.push(node('context',contextKey,contextLabel(pageGroups),pageGroups,visits(pageGroups,contextKey),page||undefined));
    }
    result.push(node('site',siteKey,domain,siteGroups,contexts));
  }
  const general=native.filter(group=>reviewContextTitle(group)==='General activity');
  result.push(...visits(general,parent));
  for(const [identity,contextGroups] of buckets(native.filter(group=>reviewContextTitle(group)!=='General activity'),group=>JSON.stringify([reviewContextTitle(group),group.detail]))){
    const contextKey=key('context',parent,identity);
    result.push(node('context',contextKey,contextLabel(contextGroups),contextGroups,visits(contextGroups,contextKey)));
  }
  return ordered(result);
}

/** Read projection only: callers pass the current period/project/search subset.
 * Every parent contains the original descendant groups, never a time envelope. */
export function buildReviewTree(groups:AppReviewGroup[],parent=''):ReviewNode[]{
  return ordered([...buckets(groups,group=>group.appKey)].map(([appKey,appGroups])=>{
    const appNodeKey=key('app',parent,appKey),label=[...new Set(appGroups.map(group=>group.appName))].sort((a,b)=>a.localeCompare(b))[0]!;
    return node('app',appNodeKey,label,appGroups,appChildren(appGroups,appNodeKey));
  }));
}

/** Project assignment is the outer grouping; no observations or durations change. */
export function buildProjectReviewTree(groups:AppReviewGroup[]):ReviewNode[]{
  const identity=(group:AppReviewGroup)=>reviewIsAssigned(group)?group.projectPath!:'';
  const projects=buckets(groups,identity),paths=[...projects.keys()].filter(Boolean);
  return ordered([...projects].map(([path,projectGroups])=>{
    const projectKey=key('project','',path);
    return node('project',projectKey,path?projectDisplay(path,paths):'Unassigned',projectGroups,buildReviewTree(projectGroups,projectKey));
  }));
}

/** Resolve a node-local selection. For a context menu with a global selection,
 * the caller keeps that full selection when any of these descendants is selected. */
export function reviewNodeSelection(node:ReviewNode,selectedIds:Readonly<Record<string,boolean>>):AppReviewGroup[]{
  const selected=node.groups.filter(group=>selectedIds[reviewGroupId(group)]);
  return selected.length?selected:[...node.groups];
}
