import {test} from 'node:test';import assert from 'node:assert/strict';
import {resolveOrcaTab,tabIndexFromTerminalList} from '../src/capture/orca-focus.ts';
const tab=(worktreeId:string,tabId:string,title:string,leafId:string,handle:string)=>({worktreeId,root:{tabs:[{tabId,title,activeLeafId:leafId,panes:{type:'terminal',handle,leafId}}]}});
test('selected visible tab resolves to stable workspace, tab and active split leaf',()=>{
 const index=tabIndexFromTerminalList({ok:true,result:{visualLayouts:[tab('w1','tab-1','Write spec','leaf-1','term-1'),tab('w2','tab-2','Other tab','leaf-2','term-2')]}});
 assert.deepEqual(resolveOrcaTab('Write spec',index),{workspaceId:'w1',tabId:'tab-1',leafId:'leaf-1',terminalHandle:'term-1',title:'Write spec'});
});
test('duplicate or unmatched labels stay unassigned and never inherit a previous tab',()=>{
 const index=tabIndexFromTerminalList({ok:true,result:{visualLayouts:[tab('w1','a','Review','leaf-1','term-1'),tab('w2','b','Review','leaf-2','term-2')]}});
 assert.equal(resolveOrcaTab('Review',index),null);assert.equal(resolveOrcaTab('Other',index),null);
});
test('a split tab uses the active leaf and refuses a missing active pane',()=>{
 const layout={worktreeId:'w',root:{tabs:[{tabId:'t',title:'Review',activeLeafId:'right',panes:{type:'split',first:{type:'terminal',leafId:'left',handle:'term-left'},second:{type:'terminal',leafId:'right',handle:'term-right'}}}]}};
 const index=tabIndexFromTerminalList({ok:true,result:{visualLayouts:[layout]}});
 assert.equal(resolveOrcaTab('Review',index)?.terminalHandle,'term-right');
 layout.root.tabs[0].activeLeafId='missing';assert.equal(resolveOrcaTab('Review',tabIndexFromTerminalList({ok:true,result:{visualLayouts:[layout]}})),null);
});
