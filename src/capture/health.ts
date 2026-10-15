import type {CaptureEvent} from './events.ts';
import type {WebsiteResolution,WebsiteSuggestion} from './website-resolver.ts';

export type HealthSource='macos'|'claude'|'codex'|'orca';
export interface HealthEvent {id:string;source:HealthSource|'capture';kind:string;observedAt:number;title:string;detail:string;project:string|null;}
export interface AccessibilityCapture {observedAt:number;windowTitle:string|null;selectedTabTitle:string|null;selectedWorktreeId:string|null;resolved:{workspaceId:string;tabId:string;leafId:string;terminalHandle:string}|null;}
export interface WebsiteHealth {key:string;observedAt:number;state:'matched'|'suggested'|'unmatched'|'checking';projectPath:string|null;source:string|null;detail:string|null;appliedAt:number|null;suggestions:WebsiteSuggestion[];}
export interface CaptureHealth {checkedAt:number;latest:Record<HealthSource,number|null>;hooks:Record<'claude'|'codex',{installed:number;total:number;needsAttention:boolean}>;accessibility:AccessibilityCapture|null;websites:WebsiteHealth[];events:HealthEvent[];}

export function websiteHealth(resolutions:WebsiteResolution[],applied:Map<string,number>,current?:{key:string;observedAt:number},now=Date.now()/1000):WebsiteHealth[]{
 const rows:WebsiteHealth[]=resolutions.filter(item=>now-item.observedAt<=600).map(item=>({
  key:item.key,observedAt:item.observedAt,state:item.projectPath?'matched':item.suggestions.length?'suggested':'unmatched',
  projectPath:item.projectPath||null,source:item.source||null,detail:item.detail||null,appliedAt:applied.get(item.key)||null,suggestions:item.suggestions.slice(0,3),
 }));
 if(current&&now-current.observedAt<=15&&!rows.some(row=>row.key===current.key))rows.push({key:current.key,observedAt:current.observedAt,state:'checking',projectPath:null,source:null,detail:null,appliedAt:null,suggestions:[]});
 return rows.sort((a,b)=>b.observedAt-a.observedAt).slice(0,12);
}

const label=(value:unknown,max=120)=>typeof value==='string'?value.slice(0,max):'';
const project=(event:CaptureEvent)=>{
  const path=event.cwd||event.workspaceId?.split('::').at(-1);
  return path?.split('/.orca/')[0].split('/').filter(Boolean).at(-1)||null;
};
const hookTitles:Record<string,string>={session_start:'Session started',session_end:'Session ended',prompt_submitted:'Prompt sent',tool_start:'Tool started',tool_end:'Tool finished',response_stop:'Response finished',child_start:'Subagent started',child_stop:'Subagent finished',waiting:'Waiting for permission',interrupted:'Interrupted'};
export function healthEvent(event:CaptureEvent):HealthEvent|null {
  const source:HealthEvent['source']=event.source==='hook'&&['claude','codex'].includes(event.provider||'')?event.provider as 'claude'|'codex':event.source as HealthEvent['source'];
  if(!['macos','claude','codex','orca','capture'].includes(source))return null;
  const data=event.data||{};let title='',detail='';
  if(source==='claude'||source==='codex'){
    title=hookTitles[event.kind]||'Agent event';
    detail=[label(data.toolName),event.sessionId?`Session ${event.sessionId.slice(-8)}`:''].filter(Boolean).join(' · ');
  }else if(source==='macos'){
    title=event.kind==='sleep'?'Mac went to sleep':event.kind==='wake'?'Mac woke up':`${label(data.foregroundName)||'Unknown app'} in foreground`;
    detail=[label(data.orcaSelectedTabTitle)||label(data.browserDomain),typeof data.idleSeconds==='number'&&data.idleSeconds>=60?'Idle':''].filter(Boolean).join(' · ');
  }else if(source==='orca'){
    title=event.kind==='worker'?'Orca worker':event.kind==='terminal'?'Orca terminal':'Orca coverage';
    detail=event.kind==='worker'?[label(data.state),label(data.outcome)].filter(Boolean).join(' · '):event.kind==='terminal'?label(data.title):label(data.reason);
  }else{
    title=event.kind==='capture_start'?'Capture started':event.kind==='capture_stop'?'Capture stopped':'Capture settings changed';
  }
  return {id:event.eventId,source,kind:event.kind,observedAt:event.observedAt,title,detail,project:project(event)};
}

export function compactHealthEvents(events:CaptureEvent[],limit=60):HealthEvent[]{
  const seen=new Set<string>(),counts=new Map<string,number>(),result:HealthEvent[]=[];
  const caps:Record<string,number>={macos:5,claude:18,codex:18,orca:12,capture:4};
  for(const event of [...events].sort((a,b)=>b.observedAt-a.observedAt)){
    if(event.source==='orca'&&(event.kind==='coverage'||event.kind==='worker'&&event.data?.fresh===false))continue;
    const item=healthEvent(event);if(!item)continue;
    if((counts.get(item.source)||0)>=caps[item.source])continue;
    const toolId=event.data?.toolId;
    const key=item.source==='macos'?`${item.source}:${item.title}:${item.detail}`:item.source==='orca'?`${item.source}:${item.kind}:${event.terminalHandle||event.dispatchId||''}:${item.detail}`:item.source==='capture'?`${item.source}:${item.kind}`:typeof toolId==='string'&&toolId?`${item.source}:${item.kind}:${event.sessionId||''}:${toolId}`:item.id;
    if(seen.has(key))continue;seen.add(key);result.push(item);counts.set(item.source,(counts.get(item.source)||0)+1);if(result.length===limit)break;
  }
  return result;
}
