import { object } from './orca.ts';
import { validateSettings, type CaptureSettings } from './settings.ts';
interface Controller { cleanupPreview?():unknown;cleanupTracking?():unknown; status():unknown; summary(maxAgeMs?:number):unknown; summaryForDate?(date:string,maxAgeMs?:number):unknown; captureHealth?():unknown; start(duration?:number):Promise<unknown>; stop():Promise<unknown>; updateSettings?(settings:Partial<CaptureSettings>):unknown; trayStatus?():unknown;usage?():unknown; hooksStatus?():unknown;verifyHooks?():unknown;installHooks?(provider:'claude'|'codex'):Promise<unknown>;dismissHookSetup?():unknown;websiteProjects?():unknown;setWebsiteRule?(pattern:string,projectPath:string):unknown;removeWebsiteRule?(pattern:string):unknown;setHumanDecision?(pairs:Array<[string,string]>,mode:'assigned'|'unassigned'|'clear',projectPath?:string):unknown;linearStatus?():Promise<unknown>;linearConnect?(clientId:string):Promise<unknown>;linearSync?(workspaceId?:string):Promise<unknown>;linearDisconnect?(workspaceId?:string):Promise<unknown>; }
export async function dispatchRequest(payload:unknown,controller:Controller):Promise<Record<string,unknown>> {
  const request=object(payload),id=request.id;
  try{
    if(typeof id!=='string'||id.length>128)throw new Error('Invalid request ID');
    const params=object(request.params);
    if(request.method==='settings'){
      if(!controller.updateSettings)throw new Error('Settings unavailable');
      return {id,result:controller.updateSettings(validateSettings(request.params))};
    }
    if(request.method==='website_rule_set'){
      if(!controller.setWebsiteRule||Object.keys(params).length!==2||typeof params.pattern!=='string'||typeof params.projectPath!=='string')throw new Error('Invalid website rule');
      return {id,result:controller.setWebsiteRule(params.pattern,params.projectPath)};
    }
    if(request.method==='website_rule_remove'){
      if(!controller.removeWebsiteRule||Object.keys(params).length!==1||typeof params.pattern!=='string')throw new Error('Invalid website rule');
      return {id,result:controller.removeWebsiteRule(params.pattern)};
    }
    if(request.method==='human_decision_set'){
      if(!controller.setHumanDecision||Object.keys(params).some(key=>!['pairs','mode','projectPath'].includes(key))||!Array.isArray(params.pairs)||!params.pairs.length||params.pairs.length>500||!['assigned','unassigned','clear'].includes(String(params.mode))||params.pairs.some(pair=>!Array.isArray(pair)||pair.length!==2||pair.some(id=>typeof id!=='string'||!id||id.length>128))||params.mode==='assigned'&&typeof params.projectPath!=='string'||params.mode!=='assigned'&&params.projectPath!==undefined)throw new Error('Invalid human activity decision');
      return {id,result:controller.setHumanDecision(params.pairs as Array<[string,string]>,params.mode as 'assigned'|'unassigned'|'clear',params.projectPath as string|undefined)};
    }
    if(request.method==='linear_connect'){
      if(!controller.linearConnect||Object.keys(params).length!==1||typeof params.clientId!=='string')throw new Error('Invalid Linear connection request');
      return {id,result:await controller.linearConnect(params.clientId)};
    }
    if(request.method==='linear_sync'||request.method==='linear_disconnect'){
      if(Object.keys(params).some(key=>key!=='workspaceId')||params.workspaceId!==undefined&&(typeof params.workspaceId!=='string'||!params.workspaceId||params.workspaceId.length>128))throw new Error('Invalid Linear workspace');
      const handler=request.method==='linear_sync'?controller.linearSync:controller.linearDisconnect;
      if(!handler)throw new Error('Linear unavailable');
      return {id,result:await handler.call(controller,params.workspaceId as string|undefined)};
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
      if(duration!==undefined&&(typeof duration!=='number'||!Number.isFinite(duration)||duration<1||duration>86400))throw new Error('Invalid capture duration');
      return {id,result:await controller.start(duration)};
    }
    if(request.method==='summary'&&params.date!==undefined){
      if(Object.keys(params).length!==1||typeof params.date!=='string'||!controller.summaryForDate)throw new Error('Invalid summary date');
      return {id,result:controller.summaryForDate(params.date,15000)};
    }
    if(Object.keys(params).length)throw new Error('Unsupported parameter');
    if(request.method==='tracking_cleanup_preview'&&controller.cleanupPreview)return {id,result:controller.cleanupPreview()};
    if(request.method==='hooks_status'&&controller.hooksStatus)return {id,result:controller.hooksStatus()};
    if(request.method==='hooks_verify'&&controller.verifyHooks)return {id,result:controller.verifyHooks()};
    if(request.method==='hooks_dismiss'&&controller.dismissHookSetup)return {id,result:controller.dismissHookSetup()};
    if(request.method==='status')return {id,result:controller.status()};
    if(request.method==='summary')return {id,result:controller.summary(15000)};
    if(request.method==='capture_health'&&controller.captureHealth)return {id,result:controller.captureHealth()};
    if(request.method==='tray_status'&&controller.trayStatus)return {id,result:controller.trayStatus()};
    if(request.method==='usage'&&controller.usage)return {id,result:controller.usage()};
    if(request.method==='website_projects'&&controller.websiteProjects)return {id,result:controller.websiteProjects()};
    if(request.method==='linear_status'&&controller.linearStatus)return {id,result:await controller.linearStatus()};
    if(request.method==='stop')return {id,result:await controller.stop()};
    throw new Error('Unknown method');
  }catch(error){return {id:typeof id==='string'?id:null,error:String(error)};}
}
