import {object} from './orca.ts';
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
