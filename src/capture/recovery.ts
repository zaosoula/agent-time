import type {SourceSnapshot} from './source-state.ts';

export interface RecoveryNotice {id:string;title:string;detail:string;action:string;}
export function recoveryNotices(input:{databaseHealthy:boolean;freeBytes:number|null;sources:SourceSnapshot[];clockShiftSeconds:number}):RecoveryNotice[]{
 const notices:RecoveryNotice[]=[];
 if(!input.databaseHealthy)notices.push({id:'database',title:'Tracking database needs repair',detail:'The local integrity check failed. Capture history may be incomplete.',action:'Pause capture, export a diagnostic summary, then restore a verified archive or contact support.'});
 if(input.freeBytes!==null&&input.freeBytes<250*1024*1024)notices.push({id:'disk',title:'Low disk space',detail:`About ${Math.max(0,Math.floor(input.freeBytes/1024/1024))} MB is available. New observations may fail to save.`,action:'Free disk space, then reopen Capture health to verify new events. Review Storage in Settings before deleting any archive.'});
 if(Math.abs(input.clockShiftSeconds)>120)notices.push({id:'clock',title:'Clock or sleep gap detected',detail:'Timing may contain an unknown interval around a sleep, wake, or clock change.',action:'Review the timeline and add a labelled manual note only if you know what happened.'});
 for(const source of input.sources){
  if(source.state==='repair-needed')notices.push({id:`hook-${source.id}`,title:`${source.name} hooks need repair`,detail:'The installed hook does not match the current runtime.',action:'Open hook setup and update only this agent’s affected installations. Start a new session afterward.'});
  else if(source.state==='failed')notices.push({id:`source-${source.id}`,title:`${source.name} capture failed`,detail:source.detail,action:'Retry capture from the app. If it fails again, preview the diagnostic summary.'});
 }
 return notices;
}
