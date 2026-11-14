import {projectDisplay} from './project-identity.ts';
import {preciseClock} from './format.ts';
import {reviewIsAssigned,reviewAssignmentLabel,reviewContextTitle,reviewGroupId,reviewVisitTitle,type AppReviewGroup} from './review-apps.ts';

export type ReviewLayout='unified'|'category'|'chronological';
export interface ReviewGrouping {byProject:boolean;byDevice:boolean;combineBrowsers:boolean;pageBy:'path'|'title';shortSeconds:number;}
export const defaultReviewGrouping:ReviewGrouping={byProject:true,byDevice:false,combineBrowsers:false,pageBy:'path',shortSeconds:15};
export interface ReviewNode {
  key:string;label:string;description?:string;
  kind:'category'|'device'|'project'|'app'|'site'|'context'|'visit'|'short';
  groups:AppReviewGroup[];seconds:number;children:ReviewNode[];
}
const trackingParameters=new Set(['fbclid','gclid','dclid','msclkid','mc_cid','mc_eid','_ga','_gl','yclid','igshid']);
function website(group:AppReviewGroup):{domain:string;page:string}|undefined{
  try{
    const url=new URL(group.browserUrl||group.browserOrigin||'');
    if(url.protocol!=='https:'&&url.protocol!=='http:')return;
    for(const key of [...url.searchParams.keys()])if(key.toLowerCase().startsWith('utm_')||trackingParameters.has(key.toLowerCase()))url.searchParams.delete(key);
    return {domain:url.hostname,page:url.href};
  }catch{if(group.browserDomain)return {domain:group.browserDomain.toLowerCase(),page:''};}
}
const key=(kind:ReviewNode['kind'],parent:string,identity:string)=>JSON.stringify([kind,parent,identity]);
const orderedGroups=(groups:AppReviewGroup[])=>[...groups].sort((a,b)=>a.start-b.start||a.end-b.end||reviewGroupId(a).localeCompare(reviewGroupId(b)));
const ordered=(nodes:ReviewNode[])=>nodes.sort((a,b)=>b.seconds-a.seconds||a.label.localeCompare(b.label)||a.key.localeCompare(b.key));
function assignment(groups:AppReviewGroup[]):string{
  const identities=new Set(groups.map(group=>JSON.stringify([group.projectPath||'',group.userAttribution||'',group.attributionSource==='conflict'])));
  return identities.size>1?'Mixed assignments':groups[0]?reviewAssignmentLabel(groups[0]):'';
}
function node(kind:ReviewNode['kind'],nodeKey:string,label:string,groups:AppReviewGroup[],children:ReviewNode[]=[],detail?:string):ReviewNode{
  return {key:nodeKey,label,kind,groups:orderedGroups(groups),seconds:groups.reduce((sum,group)=>sum+group.seconds,0),children:ordered(children),description:[detail,assignment(groups)].filter(Boolean).join(' · ')};
}
function visit(group:AppReviewGroup,parent:string,chronological=false){
 return node('visit',key('visit',parent,reviewGroupId(group)),chronological?group.appName:reviewVisitTitle(group),[group],[],`${preciseClock(group.start)}–${preciseClock(group.end)}${chronological?' · '+reviewVisitTitle(group):''}${group.browserUrl?' · '+group.browserUrl:''}`);
}
function visits(groups:AppReviewGroup[],parent:string,options:ReviewGrouping):ReviewNode[]{
  const leaves=groups.map(group=>visit(group,parent)),short=leaves.filter(leaf=>leaf.seconds<options.shortSeconds),regular=leaves.filter(leaf=>leaf.seconds>=options.shortSeconds);
  if(short.length)regular.push(node('short',key('short',parent,String(options.shortSeconds)),'Short activities',short.flatMap(leaf=>leaf.groups),short,`${short.length} visits under ${options.shortSeconds}s each`));
  return ordered(regular);
}
function buckets(groups:AppReviewGroup[],identity:(group:AppReviewGroup)=>string):Map<string,AppReviewGroup[]>{
  const result=new Map<string,AppReviewGroup[]>();
  for(const group of groups){const id=identity(group),bucket=result.get(id);if(bucket)bucket.push(group);else result.set(id,[group]);}return result;
}
function contextLabel(groups:AppReviewGroup[]):string{return [...new Set(groups.map(reviewContextTitle))].sort((a,b)=>a.localeCompare(b))[0]!;}
function contexts(groups:AppReviewGroup[],parent:string,options:ReviewGrouping):ReviewNode[]{
 const identity=(group:AppReviewGroup)=>options.pageBy==='title'?JSON.stringify([website(group)?.domain||'',reviewContextTitle(group)]):website(group)?.page||JSON.stringify([reviewContextTitle(group),group.detail]);
 return ordered([...buckets(groups,identity)].map(([identity,items])=>{
  const contextKey=key('context',parent,identity),pages=[...new Set(items.map(item=>website(item)?.page).filter(Boolean))];
  return node('context',contextKey,contextLabel(items),items,visits(items,contextKey,options),pages.length===1?pages[0]:pages.length?`${pages.length} page URLs`:undefined);
 }));
}
function sites(groups:AppReviewGroup[],parent:string,options:ReviewGrouping):ReviewNode[]{
 return ordered([...buckets(groups,group=>website(group)!.domain)].map(([domain,items])=>{
  const siteKey=key('site',parent,domain);return node('site',siteKey,domain,items,contexts(items,siteKey,options));
 }));
}
function appChildren(groups:AppReviewGroup[],parent:string,options:ReviewGrouping):ReviewNode[]{
 const web=groups.filter(group=>website(group)),native=groups.filter(group=>!website(group)),general=native.filter(group=>reviewContextTitle(group)==='General activity');
 return ordered([...sites(web,parent,options),...visits(general,parent,options),...contexts(native.filter(group=>reviewContextTitle(group)!=='General activity'),parent,options)]);
}
function apps(groups:AppReviewGroup[],parent:string,options:ReviewGrouping):ReviewNode[]{
 return ordered([...buckets(groups,group=>group.appKey)].map(([appKey,items])=>{
  const appNodeKey=key('app',parent,appKey),label=[...new Set(items.map(group=>group.appName))].sort()[0]!;
  return node('app',appNodeKey,label,items,appChildren(items,appNodeKey,options));
 }));
}
/** Read projections only: no interval clipping, counting, or attribution writes. */
export function buildReviewTree(groups:AppReviewGroup[],parent='',options:ReviewGrouping=defaultReviewGrouping):ReviewNode[]{
 if(options.byDevice)return ordered([...buckets(groups,group=>group.hostId||'Unknown device')].map(([host,items])=>{
  const deviceKey=key('device',parent,host);return node('device',deviceKey,host==='local'?'This Mac':host,items,buildReviewTree(items,deviceKey,{...options,byDevice:false}));
 }));
 if(options.combineBrowsers)return ordered([...sites(groups.filter(group=>website(group)),parent,options),...apps(groups.filter(group=>!website(group)),parent,options)]);
 return apps(groups,parent,options);
}
export function buildProjectReviewTree(groups:AppReviewGroup[],options:ReviewGrouping=defaultReviewGrouping,parent=''):ReviewNode[]{
 if(!options.byProject)return buildReviewTree(groups,parent,options);
 const projects=buckets(groups,group=>reviewIsAssigned(group)?group.projectPath!:''),paths=[...projects.keys()].filter(Boolean);
 return ordered([...projects].map(([path,items])=>{
  const projectKey=key('project',parent,path);return node('project',projectKey,path?projectDisplay(path,paths):'Unassigned',items,buildReviewTree(items,projectKey,options));
 }));
}
export function buildReviewLayout(groups:AppReviewGroup[],layout:ReviewLayout,options:ReviewGrouping):ReviewNode[]{
 if(layout==='chronological')return orderedGroups(groups).map(group=>visit(group,'chronological',true));
 if(layout==='unified')return buildProjectReviewTree(groups,options);
 // Facets deliberately overlap. Their totals must never be added together.
 const facets:Array<[string,string,AppReviewGroup[],(items:AppReviewGroup[],parent:string)=>ReviewNode[]]>=[
  ['apps','Applications',groups,(items,parent)=>apps(items,parent,options)],
  ['websites','Websites',groups.filter(group=>website(group)),(items,parent)=>sites(items,parent,options)],
  ['pages','Pages & documents',groups.filter(group=>website(group)||reviewContextTitle(group)!=='General activity'),(items,parent)=>contexts(items,parent,options)],
 ];
 return facets.filter(([_id,_label,items])=>items.length).map(([id,label,items,content])=>{
  const categoryKey=key('category','',id);
  const withDevices=(subset:AppReviewGroup[],parent:string)=>options.byDevice?[...buckets(subset,g=>g.hostId||'Unknown device')].map(([host,deviceGroups])=>{
   const deviceKey=key('device',parent,host);return node('device',deviceKey,host==='local'?'This Mac':host,deviceGroups,content(deviceGroups,deviceKey));
  }):content(subset,parent);
  let children:ReviewNode[];
  if(options.byProject){
   const projects=buckets(items,g=>reviewIsAssigned(g)?g.projectPath!:''),paths=[...projects.keys()].filter(Boolean);
   children=[...projects].map(([path,subset])=>{const projectKey=key('project',categoryKey,path);return node('project',projectKey,path?projectDisplay(path,paths):'Unassigned',subset,withDevices(subset,projectKey));});
  }else children=withDevices(items,categoryKey);
  return node('category',categoryKey,label,items,children);
 });
}
export function reviewNodeSelection(node:ReviewNode,selectedIds:Readonly<Record<string,boolean>>):AppReviewGroup[]{
 const selected=node.groups.filter(group=>selectedIds[reviewGroupId(group)]);return selected.length?selected:[...node.groups];
}
