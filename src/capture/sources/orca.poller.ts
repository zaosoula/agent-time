import {readWorkers,readFleet,workerEvent,terminalEvents} from '../orca.ts';
import {makeEvent} from '../events.ts';
import {staticOrcaScopeReason} from '../observation-retention.ts';
import {resolveOrcaTab} from '../orca-focus.ts';
import type {PollSource} from './types.ts';

export default {kind:'poller',id:'orca',name:'Orca',setting:'orcaPolling',defaultEnabled:true,
 async poll({reader,runId,valid,store}){
  const {workers,coverage}=runId?await readWorkers(reader,runId,valid):await readFleet(reader,valid);
  if(!valid())return null;
  store.putObservations(workers.map(workerEvent));
  for(const issue of coverage){const event=makeEvent('orca','coverage',{data:{reason:issue.reason}});if(issue.reason===staticOrcaScopeReason)store.putObservations([event]);else store.put(event);}
  try{const terminals=await terminalEvents(reader);if(valid())store.putObservations(terminals);}catch(error){if(valid())store.put(makeEvent('orca','coverage',{data:{reason:String(error)}}));}
  return coverage.find(issue=>!issue.reason.startsWith('Only this Orca host'))?.reason||null;
 },
 foreground(payload,event,focusedTabs,focusedTabsAt){
  if(payload.foregroundBundleId!=='com.stablyai.orca')return null;
  const focused=Date.now()-focusedTabsAt<15000?resolveOrcaTab(payload.orcaSelectedTabTitle,focusedTabs):null;
  const worktree=typeof payload.orcaSelectedWorktreeId==='string'?payload.orcaSelectedWorktreeId:undefined;
  const matchingTab=focused&&(!worktree||focused.workspaceId===worktree)?focused:null;
  if(worktree)event.workspaceId=worktree;
  if(matchingTab){event.workspaceId=matchingTab.workspaceId;event.terminalHandle=matchingTab.terminalHandle;event.data={...event.data,tabId:matchingTab.tabId,tabTitle:matchingTab.title,leafId:matchingTab.leafId};}
  const resolved=matchingTab?{workspaceId:matchingTab.workspaceId,tabId:matchingTab.tabId,leafId:matchingTab.leafId,terminalHandle:matchingTab.terminalHandle}:null;
  return {attribution:matchingTab?{...resolved,title:matchingTab.title}:null,accessibility:{observedAt:event.observedAt,windowTitle:typeof payload.orcaWindowTitle==='string'?payload.orcaWindowTitle:null,selectedTabTitle:typeof payload.orcaSelectedTabTitle==='string'?payload.orcaSelectedTabTitle:null,selectedWorktreeId:worktree||null,resolved}};
 }} satisfies PollSource;
