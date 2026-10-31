import { object } from './orca.ts';
import { validateSettings, type CaptureSettings } from './settings.ts';
import {agentById} from './sources/agent-registry.ts';
import {validateExclusions,type PrivacyExclusion} from './privacy-exclusions.ts';
import {validateManualNote,type ManualNote} from './store.ts';
interface Controller {storageUsage?():unknown;reclaimWal?():unknown;prepareStorageCompaction?():unknown;prepareStorageRestore?(id:string):unknown;cancelStorageReplacement?():unknown;storageReplacementStatus?():unknown;storageReplacementResult?():unknown;listArchives?():unknown;previewArchive?(id:string):unknown;importArchive?(id:string):unknown;deleteArchive?(id:string):unknown;captureChecks?():unknown;reviewHistory?():unknown;undoReviewAction?(id:string):unknown;setHumanGroupSplit?(pairs:Array<[string,string]>,splitAt:number,beforeProject?:string,afterProject?:string):unknown;previewWebsiteRule?(pattern:string,projectPath:string):unknown;dayReviewStatus?(date:string):unknown;markDayReview?(date:string):unknown;}
interface Controller { cleanupPreview?():unknown;cleanupTracking?():unknown;exportArchive?():Promise<unknown>; status():unknown; summary(maxAgeMs?:number):unknown; summaryForDate?(date:string,maxAgeMs?:number):unknown;weeklyReview?(startDate:string):unknown;workOutcomes?(date:string):Promise<unknown>;manualNotes?(date:string):unknown;addManualNote?(input:Omit<ManualNote,'id'|'createdAt'>):unknown;removeManualNote?(id:string):unknown; captureHealth?():unknown; diagnostics?():unknown; privacyExclusions?():unknown;setPrivacyExclusions?(entries:PrivacyExclusion[]):unknown; start(duration?:number):Promise<unknown>; stop():Promise<unknown>; updateSettings?(settings:Partial<CaptureSettings>):unknown; trayStatus?():unknown;usage?():unknown; hooksStatus?():unknown;verifyHooks?():unknown;installHooks?(provider:string,targetIds?:string[]):Promise<unknown>;dismissHookSetup?():unknown;mcpStatus?():unknown;installMcp?(provider:'claude'|'codex',targetIds?:string[]):unknown;removeMcp?(provider:'claude'|'codex',targetIds?:string[]):unknown;websiteProjects?():unknown;setWebsiteRule?(pattern:string,projectPath:string):unknown;removeWebsiteRule?(pattern:string):unknown;setHumanDecision?(pairs:Array<[string,string]>,mode:'assigned'|'unassigned'|'clear',projectPath?:string):unknown;linearStatus?():Promise<unknown>;linearConnect?(clientId:string):Promise<unknown>;linearSync?(workspaceId?:string):Promise<unknown>;linearDisconnect?(workspaceId?:string):Promise<unknown>; }
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
    if(request.method==='website_rule_preview'){
      if(!controller.previewWebsiteRule||Object.keys(params).length!==2||typeof params.pattern!=='string'||typeof params.projectPath!=='string')throw new Error('Invalid website rule preview');
      return {id,result:controller.previewWebsiteRule(params.pattern,params.projectPath)};
    }
    if(request.method==='website_rule_remove'){
      if(!controller.removeWebsiteRule||Object.keys(params).length!==1||typeof params.pattern!=='string')throw new Error('Invalid website rule');
      return {id,result:controller.removeWebsiteRule(params.pattern)};
    }
    if(request.method==='human_decision_set'){
      if(!controller.setHumanDecision||Object.keys(params).some(key=>!['pairs','mode','projectPath'].includes(key))||!Array.isArray(params.pairs)||!params.pairs.length||params.pairs.length>500||!['assigned','unassigned','clear'].includes(String(params.mode))||params.pairs.some(pair=>!Array.isArray(pair)||pair.length!==2||pair.some(id=>typeof id!=='string'||!id||id.length>128))||params.mode==='assigned'&&typeof params.projectPath!=='string'||params.mode!=='assigned'&&params.projectPath!==undefined)throw new Error('Invalid human activity decision');
      return {id,result:controller.setHumanDecision(params.pairs as Array<[string,string]>,params.mode as 'assigned'|'unassigned'|'clear',params.projectPath as string|undefined)};
    }
    if(request.method==='review_undo'){
      if(!controller.undoReviewAction||Object.keys(params).length!==1||typeof params.id!=='string'||!/^[a-f0-9-]{36}$/.test(params.id))throw new Error('Invalid review undo request');
      return {id,result:controller.undoReviewAction(params.id)};
    }
    if(request.method==='human_group_split'){
      if(!controller.setHumanGroupSplit||Object.keys(params).some(key=>!['pairs','splitAt','beforeProject','afterProject'].includes(key))||!Array.isArray(params.pairs)||!params.pairs.length||params.pairs.length>500||params.pairs.some(pair=>!Array.isArray(pair)||pair.length!==2||pair.some(id=>typeof id!=='string'||!id||id.length>128))||typeof params.splitAt!=='number'||!Number.isFinite(params.splitAt)||['beforeProject','afterProject'].some(key=>params[key]!==undefined&&typeof params[key]!=='string'))throw new Error('Invalid activity split');
      return {id,result:controller.setHumanGroupSplit(params.pairs as Array<[string,string]>,params.splitAt as number,params.beforeProject as string|undefined,params.afterProject as string|undefined)};
    }
    if(request.method==='day_review_status'||request.method==='day_review_mark'){
      if(Object.keys(params).length!==1||typeof params.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(params.date))throw new Error('Invalid review date');
      const handler=request.method==='day_review_status'?controller.dayReviewStatus:controller.markDayReview;
      if(!handler)throw new Error('Daily review unavailable');
      return {id,result:handler.call(controller,params.date)};
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
      if(!controller.installHooks||!request.params||Object.keys(params).some(key=>!['provider','targetIds'].includes(key))||typeof params.provider!=='string'||!agentById.has(params.provider)||params.targetIds!==undefined&&(!Array.isArray(params.targetIds)||!params.targetIds.length||params.targetIds.length>100||params.targetIds.some(value=>typeof value!=='string'||!/^[a-f0-9]{16}$/.test(value))))throw new Error('Invalid hook installation request');
      return {id,result:await controller.installHooks(params.provider,params.targetIds as string[]|undefined)};
    }
    if(request.method==='mcp_install'||request.method==='mcp_remove'){
      if(Object.keys(params).some(key=>!['provider','targetIds'].includes(key))||(params.provider!=='claude'&&params.provider!=='codex')||params.targetIds!==undefined&&(!Array.isArray(params.targetIds)||!params.targetIds.length||params.targetIds.length>100||params.targetIds.some(value=>typeof value!=='string'||!/^[a-f0-9]{16}$/.test(value))))throw new Error('Invalid MCP installation request');
      const handler=request.method==='mcp_install'?controller.installMcp:controller.removeMcp;
      if(!handler)throw new Error('MCP installation unavailable');
      return {id,result:handler.call(controller,params.provider,params.targetIds as string[]|undefined)};
    }
    if(request.method==='privacy_exclusions_set'){
      if(!controller.setPrivacyExclusions||Object.keys(params).length!==1||!('entries' in params))throw new Error('Invalid privacy exclusion request');
      return {id,result:controller.setPrivacyExclusions(validateExclusions(params.entries))};
    }
    if(request.method==='start') {
      if(Object.keys(params).some(k=>k!=='durationSeconds'))throw new Error('Unsupported parameter');
      const duration=params.durationSeconds;
      if(duration!==undefined&&(typeof duration!=='number'||!Number.isFinite(duration)||duration<1||duration>86400))throw new Error('Invalid capture duration');
      return {id,result:await controller.start(duration)};
    }
    if(request.method==='summary'&&params.date!==undefined){
      if(Object.keys(params).some(key=>key!=='date'&&key!=='background')||typeof params.date!=='string'||params.background!==undefined&&typeof params.background!=='boolean'||!controller.summaryForDate)throw new Error('Invalid summary date');
      return {id,result:controller.summaryForDate(params.date,params.background===true?60000:15000)};
    }
    if(request.method==='weekly_review'){
      if(!controller.weeklyReview||Object.keys(params).length!==1||typeof params.startDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(params.startDate))throw new Error('Invalid week start');
      return {id,result:controller.weeklyReview(params.startDate)};
    }
    if(request.method==='work_outcomes'){
      if(!controller.workOutcomes||Object.keys(params).length!==1||typeof params.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(params.date))throw new Error('Invalid work outcome date');
      return {id,result:await controller.workOutcomes(params.date)};
    }
    if(request.method==='manual_notes'){
      if(!controller.manualNotes||Object.keys(params).length!==1||typeof params.date!=='string')throw new Error('Invalid manual note date');
      return {id,result:controller.manualNotes(params.date)};
    }
    if(request.method==='manual_note_add'){
      if(!controller.addManualNote||Object.keys(params).length!==4)throw new Error('Invalid manual note');
      return {id,result:controller.addManualNote(validateManualNote(params))};
    }
    if(request.method==='manual_note_remove'){
      if(!controller.removeManualNote||Object.keys(params).length!==1||typeof params.id!=='string')throw new Error('Invalid manual note ID');
      return {id,result:controller.removeManualNote(params.id)};
    }
    if(request.method==='archive_preview'||request.method==='archive_import'){
      if(Object.keys(params).length!==1||typeof params.id!=='string')throw new Error('Invalid archive request');
      const handler=request.method==='archive_preview'?controller.previewArchive:controller.importArchive;
      if(!handler)throw new Error('Archive operation unavailable');
      return {id,result:handler.call(controller,params.id)};
    }
    if(request.method==='archive_delete'){
      if(Object.keys(params).length!==2||typeof params.id!=='string'||params.confirmed!==true||!controller.deleteArchive)throw new Error('Archive deletion requires confirmation');
      return {id,result:controller.deleteArchive(params.id)};
    }
    if(request.method==='storage_restore_prepare'){
      if(Object.keys(params).length!==2||typeof params.id!=='string'||params.confirmed!==true||!controller.prepareStorageRestore)throw new Error('Storage replacement requires confirmation');
      return {id,result:controller.prepareStorageRestore(params.id)};
    }
    if(Object.keys(params).length)throw new Error('Unsupported parameter');
    if(request.method==='tracking_cleanup_preview'&&controller.cleanupPreview)return {id,result:controller.cleanupPreview()};
    if(request.method==='hooks_status'&&controller.hooksStatus)return {id,result:controller.hooksStatus()};
    if(request.method==='mcp_status'&&controller.mcpStatus)return {id,result:controller.mcpStatus()};
    if(request.method==='hooks_verify'&&controller.verifyHooks)return {id,result:controller.verifyHooks()};
    if(request.method==='hooks_dismiss'&&controller.dismissHookSetup)return {id,result:controller.dismissHookSetup()};
    if(request.method==='status')return {id,result:controller.status()};
    if(request.method==='review_history'&&controller.reviewHistory)return {id,result:controller.reviewHistory()};
    if(request.method==='summary')return {id,result:controller.summary(15000)};
    if(request.method==='capture_health'&&controller.captureHealth)return {id,result:controller.captureHealth()};
    if(request.method==='capture_checks'&&controller.captureChecks)return {id,result:controller.captureChecks()};
    if(request.method==='diagnostics'&&controller.diagnostics)return {id,result:controller.diagnostics()};
    if(request.method==='export_archive'&&controller.exportArchive)return {id,result:await controller.exportArchive()};
    if(request.method==='archive_list'&&controller.listArchives)return {id,result:controller.listArchives()};
    if(request.method==='storage_usage'&&controller.storageUsage)return {id,result:controller.storageUsage()};
    if(request.method==='storage_reclaim'&&controller.reclaimWal)return {id,result:controller.reclaimWal()};
    if(request.method==='storage_compact_prepare'&&controller.prepareStorageCompaction)return {id,result:controller.prepareStorageCompaction()};
    if(request.method==='storage_replacement_cancel'&&controller.cancelStorageReplacement)return {id,result:controller.cancelStorageReplacement()};
    if(request.method==='storage_replacement_status'&&controller.storageReplacementStatus)return {id,result:controller.storageReplacementStatus()};
    if(request.method==='storage_replacement_result'&&controller.storageReplacementResult)return {id,result:controller.storageReplacementResult()};
    if(request.method==='privacy_exclusions'&&controller.privacyExclusions)return {id,result:controller.privacyExclusions()};
    if(request.method==='tray_status'&&controller.trayStatus)return {id,result:controller.trayStatus()};
    if(request.method==='usage'&&controller.usage)return {id,result:controller.usage()};
    if(request.method==='website_projects'&&controller.websiteProjects)return {id,result:controller.websiteProjects()};
    if(request.method==='linear_status'&&controller.linearStatus)return {id,result:await controller.linearStatus()};
    if(request.method==='stop')return {id,result:await controller.stop()};
    throw new Error('Unknown method');
  }catch(error){return {id:typeof id==='string'?id:null,error:String(error)};}
}
