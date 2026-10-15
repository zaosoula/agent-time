import type {Interval,Session} from './events.ts';
const object=(value:unknown):Record<string,any>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:{};
export interface FocusedOrcaTab {workspaceId:string;tabId:string;leafId:string;terminalHandle:string;title:string;}
function terminal(node:unknown,leafId:string):string|null{
 const pane=object(node);
 if(pane.type==='terminal'&&pane.leafId===leafId&&typeof pane.handle==='string')return pane.handle;
 for(const child of [pane.first,pane.second,pane.left,pane.right,...(Array.isArray(pane.children)?pane.children:[])]){if(!child)continue;const handle=terminal(child,leafId);if(handle)return handle;}
 return null;
}
export function tabIndexFromTerminalList(receipt:unknown):FocusedOrcaTab[]{
 const response=object(receipt),result=object(response.result);if(response.ok!==true||!Array.isArray(result.visualLayouts)||result.truncated===true)return [];
 const index:FocusedOrcaTab[]=[];
 for(const raw of result.visualLayouts){const layout=object(raw),root=object(layout.root);if(typeof layout.worktreeId!=='string'||!Array.isArray(root.tabs))continue;
  for(const rawTab of root.tabs){const tab=object(rawTab);if(typeof tab.tabId!=='string'||typeof tab.title!=='string'||typeof tab.activeLeafId!=='string')continue;const handle=terminal(tab.panes,tab.activeLeafId);if(handle)index.push({workspaceId:layout.worktreeId,tabId:tab.tabId,leafId:tab.activeLeafId,terminalHandle:handle,title:tab.title});}
 }
 return index;
}
export function resolveOrcaTab(label:string|undefined,index:FocusedOrcaTab[]):FocusedOrcaTab|null{
 const value=label?.trim().toLocaleLowerCase();if(!value)return null;
 const exact=index.filter(t=>t.title.trim().toLocaleLowerCase()===value);if(exact.length===1)return exact[0];if(exact.length>1)return null;
 // Orca can visually truncate long labels; require a useful prefix and one match.
 if(value.length<12)return null;const prefix=index.filter(t=>t.title.trim().toLocaleLowerCase().startsWith(value));return prefix.length===1?prefix[0]:null;
}
export function humanIntervalsBySession(sessions:Session[],intervals:Interval[]):Map<string,Interval[]>{
 const bounds=new Map<string,[number,number]>();
 for(const i of intervals.filter(i=>i.state==='grouped'&&!i.child)){
  const key=i.dispatchId?`dispatch:${i.hostId}:${i.dispatchId}`:`session:${i.hostId}:${i.sessionId}`;
  const range=bounds.get(key);bounds.set(key,range?[Math.min(range[0],i.start),Math.max(range[1],i.end)]:[i.start,i.end]);
 }
 const candidates=sessions.filter(s=>!s.child&&bounds.has(s.key)).map(s=>({session:s,bounds:bounds.get(s.key)!}));
 const assigned=new Map<string,Interval[]>();
 for(const i of intervals.filter(i=>i.state==='human'&&!i.userAttribution&&(i.terminalHandle||i.tabTitle))){
  const label=i.tabTitle?.trim().toLocaleLowerCase();
  const matching=candidates.filter(x=>i.start<x.bounds[1]&&i.end>x.bounds[0]&&(
   i.terminalHandle?x.session.terminalHandle===i.terminalHandle&&x.session.workspaceId===i.workspaceId:
   label&&label.length>=12&&(!i.workspaceId||i.workspaceId===x.session.workspaceId)&&x.session.title.trim().toLocaleLowerCase().startsWith(label)
  ));
  if(matching.length!==1)continue;
  const {session,bounds:[start,end]}=matching[0],rows=assigned.get(session.key)||[];
  rows.push({...i,start:Math.max(i.start,start),end:Math.min(i.end,end)});assigned.set(session.key,rows);
 }
 return assigned;
}
export function humanIntervalsForSession(session:Session,sessions:Session[],intervals:Interval[]):Interval[]{return humanIntervalsBySession(sessions,intervals).get(session.key)||[];}
