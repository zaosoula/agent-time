import { object } from './orca.ts';
import { validateSettings, type CaptureSettings } from './settings.ts';
interface Controller { cleanupPreview?():unknown;cleanupTracking?():unknown; status():unknown; summary():unknown; start(duration:number):Promise<unknown>; stop():Promise<unknown>; updateSettings?(settings:Partial<CaptureSettings>):unknown; trayStatus?():unknown;usage?():unknown; hooksStatus?():unknown;verifyHooks?():unknown;installHooks?(provider:'claude'|'codex'):Promise<unknown>;dismissHookSetup?():unknown; }
export async function dispatchRequest(payload:unknown,controller:Controller):Promise<Record<string,unknown>> {
  const request=object(payload),id=request.id;
  try{
    if(typeof id!=='string'||id.length>128)throw new Error('Invalid request ID');
    const params=object(request.params);
    if(request.method==='settings'){
      if(!controller.updateSettings)throw new Error('Settings unavailable');
      return {id,result:controller.updateSettings(validateSettings(request.params))};
    }
    if(request.method==='tracking_cleanup'){
      if(!controller.cleanupTracking||Object.keys(params).length!==1||params.confirmed!==true)throw new Error('Cleanup requires explicit confirmation');
      return {id,result:controller.cleanupTracking()};
    }
    if(request.method==='hooks_install'){
      if(!controller.installHooks||!request.params||Object.keys(params).length!==1||!['claude','codex'].includes(params.provider))throw new Error('Invalid hook installation request');
      return {id,result:await controller.installHooks(params.provider)};
    }
    if(request.method==='start') {
      if(Object.keys(params).some(k=>k!=='durationSeconds'))throw new Error('Unsupported parameter');
      const duration=params.durationSeconds;
      if(typeof duration!=='number'||!Number.isFinite(duration)||duration<1||duration>86400)throw new Error('Invalid capture duration');
      return {id,result:await controller.start(duration)};
    }
    if(Object.keys(params).length)throw new Error('Unsupported parameter');
    if(request.method==='tracking_cleanup_preview'&&controller.cleanupPreview)return {id,result:controller.cleanupPreview()};
    if(request.method==='hooks_status'&&controller.hooksStatus)return {id,result:controller.hooksStatus()};
    if(request.method==='hooks_verify'&&controller.verifyHooks)return {id,result:controller.verifyHooks()};
    if(request.method==='hooks_dismiss'&&controller.dismissHookSetup)return {id,result:controller.dismissHookSetup()};
    if(request.method==='status')return {id,result:controller.status()};
    if(request.method==='summary')return {id,result:controller.summary()};
    if(request.method==='tray_status'&&controller.trayStatus)return {id,result:controller.trayStatus()};
    if(request.method==='usage'&&controller.usage)return {id,result:controller.usage()};
    if(request.method==='stop')return {id,result:await controller.stop()};
    throw new Error('Unknown method');
  }catch(error){return {id:typeof id==='string'?id:null,error:String(error)};}
}
