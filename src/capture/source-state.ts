import type {CaptureSettings} from './settings.ts';
import type {HookInstallationStatus} from './hook-installation.ts';
import {sourceMetadata} from './sources/registry.ts';

export type SourceState='off'|'paused'|'unavailable'|'excluded'|'repair-needed'|'waiting'|'receiving'|'permission-limited'|'stale'|'failed';
export interface SourceSnapshot {id:string;name:string;state:SourceState;lastEvent:number|null;action:'none'|'resume'|'repair-hooks'|'start-session'|'open-browser'|'grant-accessibility'|'retry';detail:string;}
export interface SourceStateInput {
 running:boolean;surfaces:CaptureSettings;orcaAvailable:boolean;lastPoll:number|null;failedPoller:string|null;
 latest:Record<string,number|null>;hooks:Pick<HookInstallationStatus,'targets'>;
 macosTrusted:boolean|null;macosExcluded:boolean;macError:boolean;foregroundBundleId:string|null;browserDetailAvailable:boolean;now:number;
}
export function sourceStates(input:SourceStateInput):SourceSnapshot[]{
 const sources:Array<{id:string;name:string;setting:string;kind:string;bundleId?:string}>=[{id:'macos',name:'Mac activity',setting:'macosActivity',kind:'poller'},...sourceMetadata];
 return sources.map(source=>{
  const enabled=input.surfaces[source.setting]===true,lastEvent=source.kind==='browser'&&source.bundleId===input.foregroundBundleId?input.latest.macos??null:input.latest[source.id]??null;
  const base={id:source.id,name:source.name,lastEvent};
  if(!enabled)return {...base,state:'off',action:'none',detail:'Disabled in Settings'};
  if(!input.running)return {...base,state:'paused',action:'resume',detail:'Resume capture'};
  if(source.id==='macos'&&input.macosExcluded)return {...base,state:'excluded',action:'none',detail:'This app or website is excluded from capture'};
  if(source.id==='macos'&&input.macError)return {...base,state:'failed',action:'retry',detail:'macOS activity helper reported an error'};
  if(source.id==='orca'&&!input.orcaAvailable)return {...base,state:'unavailable',action:'none',detail:'Orca is optional and is not installed'};
  if(source.kind==='browser'){
   if(!input.surfaces.macosActivity)return {...base,state:'unavailable',action:'none',detail:'Enable Mac activity to collect browser pages'};
   if(source.bundleId!==input.foregroundBundleId)return {...base,state:'waiting',action:'open-browser',detail:'Open this browser to verify website capture'};
   if(input.macosExcluded)return {...base,state:'excluded',action:'none',detail:'Foreground browser sample is excluded'};
   if(input.macError)return {...base,state:'failed',action:'retry',detail:'macOS activity helper reported an error'};
   if(!lastEvent||input.now-lastEvent>30)return {...base,state:'stale',action:'retry',detail:'No recent browser observation'};
   if(!input.browserDetailAvailable)return {...base,state:'permission-limited',action:input.macosTrusted===false?'grant-accessibility':'retry',detail:'Foreground browser detected, but no current page domain is available'};
   return {...base,state:'receiving',action:'none',detail:'Current browser page observed'};
  }
  if(source.kind==='agent'){
   const targets=input.hooks.targets.filter(target=>target.provider===source.id);
   if(targets.some(target=>target.state==='needs-update'||target.state==='error')||!targets.length||targets.some(target=>target.state==='not-installed'))
    return {...base,state:'repair-needed',action:'repair-hooks',detail:'Install or repair agent hooks'};
   if(!lastEvent)return {...base,state:'waiting',action:'start-session',detail:'Start a new session; in Codex, trust Agent Time in /hooks'};
   // An old event proves past delivery, but not that an agent is active now.
   return {...base,state:'receiving',action:'none',detail:'Hook event received; no active session is implied'};
  }
  const latest=source.id==='orca'?input.lastPoll:lastEvent;
  if(input.failedPoller===source.id)return {...base,state:'failed',action:'retry',detail:'Collector reported a poll error'};
  if(!latest)return {...base,state:'waiting',action:'none',detail:'Waiting for first observation'};
  if(input.now-latest>(source.id==='macos'?30:60))return {...base,state:'stale',action:'retry',detail:'No recent observation'};
  if(source.id==='macos'&&input.macosTrusted===false)
   return {...base,state:'permission-limited',action:'grant-accessibility',detail:'Foreground capture works; Accessibility can add tab detail'};
  return {...base,state:'receiving',action:'none',detail:'Recent observation received'};
 });
}
