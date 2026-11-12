import type {CaptureEvent,Interval,Session} from '../capture/events.ts';
import {applyWorkAttributes,validateAttributes,eventWorkMetadata,type WorkMetadata} from '../capture/work-context.ts';
import {agentSessionKey} from '../capture/session-identity.ts';
export interface AgentFilter {agentIdentityId?:string;agentProfile?:string;}
export const hasAgentFilter=(filter:AgentFilter)=>Boolean(filter.agentIdentityId||filter.agentProfile);
export const matchesAgent=(metadata:WorkMetadata,filter:AgentFilter)=> (!filter.agentIdentityId||metadata.agentIdentity?.id===filter.agentIdentityId)&&(!filter.agentProfile||metadata.agentProfile===filter.agentProfile);
/** Index per request, scoped by native execution and host. Hostless reports require one unambiguous host. */
export function metadataResolver(events:CaptureEvent[],executions:Array<Interval|Session>){
 const hosts=new Map<string,Set<string>>();
 for(const item of executions){const key=JSON.stringify([item.provider,item.sessionId]),set=hosts.get(key)||new Set<string>();set.add(item.hostId||'');hosts.set(key,set);}
 const matching=(event:CaptureEvent,item:Interval|Session)=>event.provider===item.provider&&event.sessionId===item.sessionId&&Boolean(item.sessionId)&&
  (event.hostId?event.hostId===item.hostId:(hosts.get(JSON.stringify([item.provider,item.sessionId]))?.size||0)<=1)&&
  (item.child?event.agentId===item.agentId:!event.agentId)&&(!event.workspaceId||!item.workspaceId||event.workspaceId===item.workspaceId);
 const evidence=events.filter(e=>(e.source==='hook'||e.source==='agent_report'&&e.kind==='work_context')&&(e.data?.agentIdentity!==undefined||e.data?.attributes!==undefined||e.data?.agentProfile!==undefined||e.data?.childType!==undefined)).sort((a,b)=>a.observedAt-b.observedAt);
 const cache=new Map<string,CaptureEvent[]>();
 const declarations=(item:Interval|Session)=>{const key=agentSessionKey(item);let rows=cache.get(key);if(!rows){rows=evidence.filter(e=>matching(e,item));cache.set(key,rows);}return rows;};
 function at(item:Interval|Session,time:number){
  if('attributionSource' in item&&item.attributionSource==='task-counter'){
   const task=events.find(event=>event.source==='agent_report'&&event.kind==='task_start'&&item.sourceEventIds.includes(event.eventId));
   if(task)return {...eventWorkMetadata(task),metadataSource:'agent-report' as const,sourceEventIds:[task.eventId],moreSourceEvents:false};
  }
  let metadata:WorkMetadata={},sourceEventIds:string[]=[],launcher=false,reported=false;
  const preceding=declarations(item).filter(event=>event.observedAt<=time);
  // Launcher observations form the baseline; repeated hooks never undo explicit declarations.
  for(const event of [...preceding.filter(event=>event.source==='hook'),...preceding.filter(event=>event.source==='agent_report')]){
   const next=eventWorkMetadata(event);
   // Raw tombstones are intentionally applied, even when the resulting map is empty.
   if(event.data?.attributes!==undefined)try{metadata.attributes=applyWorkAttributes(metadata.attributes,validateAttributes(event.data.attributes));}catch{/* Invalid imported evidence cannot replace valid context. */}
   if(next.agentIdentity)metadata.agentIdentity=next.agentIdentity;
   if(next.agentProfile)metadata.agentProfile=next.agentProfile;
   if(next.agentIdentity||next.agentProfile||next.attributes){sourceEventIds.push(event.eventId);if(event.source==='hook')launcher=true;else reported=true;}
  }
  if(!sourceEventIds.length&&!declarations(item).length){metadata={agentIdentity:item.agentIdentity,agentProfile:item.agentProfile,attributes:item.attributes,metadataSource:item.metadataSource};}
  else metadata.metadataSource=launcher&&reported?'mixed':reported?'agent-report':'launcher';
  return {...metadata,sourceEventIds:sourceEventIds.slice(-32),moreSourceEvents:sourceEventIds.length>32};
 }
 function slices<T extends Interval>(item:T){
  const boundaries=[item.start,...(item.attributionSource==='task-counter'?[]:declarations(item)).filter(e=>e.observedAt>item.start&&e.observedAt<item.end).map(e=>e.observedAt),item.end];
  return [...new Set(boundaries)].sort((a,b)=>a-b).slice(0,-1).map((start,index,all)=>{
   const end=[...new Set(boundaries)].sort((a,b)=>a-b)[index+1]!;
   const meta=at(item,start);return {...item,start,end,...meta,sourceEventIds:[...new Set([...item.sourceEventIds,...meta.sourceEventIds])].slice(0,32),observedSeconds:end-start};
  });
 }
 return {at,slices};
}
