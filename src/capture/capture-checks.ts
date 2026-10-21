import type {CaptureHealth} from './health.ts';
import type {HookInstallationStatus} from './hook-installation.ts';
import type {SourceSnapshot} from './source-state.ts';
import {sourceMetadata} from './sources/registry.ts';

export type CheckResult='pass'|'waiting'|'fail'|'skip';
export interface CaptureCheckStep {id:string;label:string;result:CheckResult;detail:string;}
export interface CaptureCheck {id:string;name:string;result:CheckResult;action:SourceSnapshot['action'];steps:CaptureCheckStep[];}
const overall=(steps:CaptureCheckStep[]):CheckResult=>steps.some(step=>step.result==='fail')?'fail':steps.some(step=>step.result==='waiting')?'waiting':steps.every(step=>step.result==='skip')?'skip':'pass';
export function captureChecks(health:CaptureHealth,hooks:HookInstallationStatus):CaptureCheck[]{
 return health.sources.map(source=>{
  const metadata=sourceMetadata.find(item=>item.id===source.id);
  const kind=metadata?.kind||'poller';
  const steps:CaptureCheckStep[]=[];
  if(source.state==='off'||source.state==='paused'){
   steps.push({id:'enabled',label:'Capture enabled',result:source.state==='off'?'skip':'waiting',detail:source.detail});
   return {...source,result:overall(steps),steps};
  }
  steps.push({id:'enabled',label:'Capture enabled',result:'pass',detail:'Enabled in Settings'});
  if(kind==='agent'){
   const targets=hooks.targets.filter(target=>target.provider===source.id);
   const installed=source.state!=='repair-needed'&&targets.length>0&&hooks.runtimeReady&&targets.every(target=>target.state==='installed');
   steps.push({id:'configuration',label:'Current hook configuration',result:installed?'pass':'fail',detail:installed?`${targets.length} installation${targets.length===1?'':'s'} current`:source.state==='repair-needed'?source.detail:targets.map(target=>target.reason||target.state).join('; ')||'No hook installation found'});
   if(installed){
    const delivered=targets.filter(target=>target.lastEvent!==null).length;
    steps.push({id:'delivery',label:'Event from current runtime',result:delivered===targets.length?'pass':'waiting',detail:delivered===targets.length?'Every installation delivered an event':`${delivered} of ${targets.length} installations delivered an event. Start a new session; review Codex trust in /hooks.`});
   }
  }else{
   const state=source.state;
   const result:CheckResult=state==='failed'||state==='stale'?'fail':state==='receiving'||state==='permission-limited'?'pass':state==='unavailable'?'skip':'waiting';
   steps.push({id:'observation',label:kind==='browser'?'Current page observed':'Recent observation',result,detail:source.detail});
   if(state==='permission-limited')steps.push({id:'page-detail',label:'Optional page detail',result:'waiting',detail:source.detail});
  }
  return {id:source.id,name:source.name,result:overall(steps),action:source.action,steps};
 });
}
