import {readWorkers,readFleet,workerEvent,informativeWorker,terminalEvents,FleetCache} from '../orca.ts';
import {makeEvent} from '../events.ts';
import {staticOrcaScopeReason} from '../observation-retention.ts';
import {resolveOrcaTab} from '../orca-focus.ts';
import type {PollSource} from './types.ts';

export default {kind:'poller',id:'orca',name:'Orca',setting:'orcaPolling',defaultEnabled:true,
 async poll({reader,runId,valid,store,memory,terminals,coverage:note}){
  const record=note||((reason:string)=>{store.put(makeEvent('orca','coverage',{data:{reason}}));});
  const fleet=memory?(memory.fleet as FleetCache|undefined)||(memory.fleet=new FleetCache()) as FleetCache:undefined;
  const {workers,coverage}=runId?await readWorkers(reader,runId,valid):await readFleet(reader,valid,fleet);
  if(!valid())return null;
  store.putObservations(workers.map(workerEvent).filter(informativeWorker));
  for(const issue of coverage){if(issue.reason===staticOrcaScopeReason)store.putObservations([makeEvent('orca','coverage',{data:{reason:issue.reason}})]);else record(issue.reason);}
  try{const events=await terminalEvents(reader,terminals);if(valid())store.putObservations(events);}catch(error){if(valid())record(String(error));}
  return coverage.find(issue=>!issue.reason.startsWith('Only this Orca host'))?.reason||null;
 },
 foreground(payload,event,focusedTabs,focusedTabsAt){
  if(payload.foregroundBundleId!=='com.stablyai.orca')return null;
  // Tab layouts refresh about every 15 s; allow one missed refresh.
  const focused=Date.now()-focusedTabsAt<30000?resolveOrcaTab(payload.orcaSelectedTabTitle,focusedTabs):null;
  const worktree=typeof payload.orcaSelectedWorktreeId==='string'?payload.orcaSelectedWorktreeId:undefined;
  const matchingTab=focused&&(!worktree||focused.workspaceId===worktree)?focused:null;
  if(worktree)event.workspaceId=worktree;
  if(matchingTab){event.workspaceId=matchingTab.workspaceId;event.terminalHandle=matchingTab.terminalHandle;event.data={...event.data,tabId:matchingTab.tabId,tabTitle:matchingTab.title,leafId:matchingTab.leafId};}
  const resolved=matchingTab?{workspaceId:matchingTab.workspaceId,tabId:matchingTab.tabId,leafId:matchingTab.leafId,terminalHandle:matchingTab.terminalHandle}:null;
  return {attribution:matchingTab?{...resolved,title:matchingTab.title}:null,accessibility:{observedAt:event.observedAt,windowTitle:typeof payload.orcaWindowTitle==='string'?payload.orcaWindowTitle:null,selectedTabTitle:typeof payload.orcaSelectedTabTitle==='string'?payload.orcaSelectedTabTitle:null,selectedWorktreeId:worktree||null,resolved}};
 }} satisfies PollSource;
