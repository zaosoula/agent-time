import type { Summary } from '../capture/events.ts';
import type { CaptureSettings } from '../capture/settings.ts';
import type {HookInstallationStatus,HookProvider,TrackingCleanupPreview,TrackingCleanupResult} from '../capture/hook-installation.ts';
import type {UsageSummary} from '../usage/reader.ts';
import type {CaptureHealth} from '../capture/health.ts';
import type {DiagnosticSummary} from '../capture/diagnostics.ts';
import type {WebsiteResolution,WebsiteRule} from '../capture/website-resolver.ts';
import type {LinearStatus} from '../capture/linear.ts';
import type {PrivacyExclusion} from '../capture/privacy-exclusions.ts';
import type {WeeklyReview} from '../capture/weekly.ts';
import type {ArchivePreview,ManualNote} from '../capture/store.ts';
import type {StorageUsage} from '../capture/storage-usage.ts';
import type {CaptureCheck} from '../capture/capture-checks.ts';
export interface LinearConnectionStatus extends LinearStatus {repositoryMatches:Record<string,string[]>;}
export interface WebsiteProjectStatus {rules:WebsiteRule[];projects:string[];matches:WebsiteResolution[];}
export interface WebsiteRuleImpact {pattern:string;projectPath:string;observedIntervals:number;affectedIntervals:number;examples:Array<{url:string;currentProject:string|null;seconds:number}>;windowDays:7;}
export interface CaptureSourceInfo {kind:'agent'|'browser'|'poller';id:string;name:string;detail?:string;setting:string;defaultEnabled:boolean;bundleId?:string;usageSetting?:string;}
export interface CaptureStatus { running:boolean;orcaAvailable:boolean;orcaPolling:boolean;surfaces:CaptureSettings;sources:CaptureSourceInfo[];lastPoll:number|null;lastError:string|null;eventCount:number;output:string;macos:({orcaAttribution?:{workspaceId:string;tabId:string;title:string}|null}&Record<string,unknown>)|null; }
export interface StartupItemStatus {status:'enabled'|'requiresApproval'|'notRegistered'|'notFound'|'unknown';}
export const native=Boolean('__TAURI_INTERNALS__' in window);
export async function request<T>(method:string,params:Record<string,unknown>={}):Promise<T>{
 if(native){const {invoke}=await import('@tauri-apps/api/core');return invoke<T>('capture_request',{method,params});}
 const response=await fetch('/__capture',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:crypto.randomUUID(),method,params})});
 if(!response.ok)throw new Error('Local collector unavailable. Start the app or the development server.');
 const reply=await response.json();if(reply.error)throw new Error(reply.error);return reply.result as T;
}
export const privacyTransport={list:()=>request<PrivacyExclusion[]>('privacy_exclusions'),replace:(entries:PrivacyExclusion[])=>request<PrivacyExclusion[]>('privacy_exclusions_set',{entries})};
export const weeklyTransport={review:(startDate:string)=>request<WeeklyReview>('weekly_review',{startDate})};
export const manualNoteTransport={list:(date:string)=>request<ManualNote[]>('manual_notes',{date}),add:(note:Omit<ManualNote,'id'|'createdAt'>)=>request<ManualNote>('manual_note_add',note),remove:(id:string)=>request<boolean>('manual_note_remove',{id})};
export const archiveTransport={
 export:()=>request<{path:string;bytes:number;events:number}>('export_archive'),
 choose:async()=>{if(!native)throw new Error('Archive file picker requires the desktop app');const {invoke}=await import('@tauri-apps/api/core');return invoke<string|null>('stage_archive');},
 list:()=>request<Array<{id:string;bytes:number}>>('archive_list'),
 preview:(id:string)=>request<ArchivePreview>('archive_preview',{id}),
 import:(id:string)=>request<{addedEvents:number;addedNotes:number;addedDecisions:number}>('archive_import',{id}),
 remove:(id:string)=>request<boolean>('archive_delete',{id,confirmed:true}),
};
export const storageTransport={usage:()=>request<StorageUsage>('storage_usage'),reclaim:()=>request<StorageUsage>('storage_reclaim')};
export interface PreparedStorage {candidate:string;backup:string;beforeRows:number;afterRows:number;beforeBytes:number;afterBytes:number;savingsBytes:number;}
export interface PendingStorage {candidate:string;backup:string;kind:'compaction'|'restore';}
export interface StorageReplacementResult {status:'applied'|'stale';kind:'compaction'|'restore';backup:string;at:string;}
export const storageRecoveryTransport={
 prepare:()=>request<PreparedStorage>('storage_compact_prepare'),
 prepareRestore:(id:string)=>request<{candidate:string;backup:string;bytes:number}>('storage_restore_prepare',{id,confirmed:true}),
 pending:()=>request<PendingStorage|null>('storage_replacement_status'),
 result:()=>request<StorageReplacementResult|null>('storage_replacement_result'),
 cancel:()=>request<boolean>('storage_replacement_cancel'),
};
export const transport={cleanupPreview:()=>request<TrackingCleanupPreview>('tracking_cleanup_preview'),cleanupTracking:()=>request<TrackingCleanupResult>('tracking_cleanup',{confirmed:true}),hooksStatus:()=>request<HookInstallationStatus>('hooks_status'),verifyHooks:()=>request<HookInstallationStatus>('hooks_verify'),installHooks:(provider:HookProvider,targetIds?:string[])=>request<HookInstallationStatus>('hooks_install',{provider,...(targetIds?{targetIds}:{})}),dismissHookSetup:()=>request<HookInstallationStatus>('hooks_dismiss'),status:()=>request<CaptureStatus>('status'),summary:(date:string)=>request<Summary>('summary',{date}),captureHealth:()=>request<CaptureHealth>('capture_health'),captureChecks:()=>request<CaptureCheck[]>('capture_checks'),diagnostics:()=>request<DiagnosticSummary>('diagnostics'),usage:()=>request<UsageSummary>('usage'),websiteProjects:()=>request<WebsiteProjectStatus>('website_projects'),setWebsiteRule:(pattern:string,projectPath:string)=>request<WebsiteProjectStatus>('website_rule_set',{pattern,projectPath}),removeWebsiteRule:(pattern:string)=>request<WebsiteProjectStatus>('website_rule_remove',{pattern}),setHumanDecision:(pairs:Array<[string,string]>,mode:'assigned'|'unassigned'|'clear',projectPath?:string)=>request<Summary>('human_decision_set',{pairs,mode,...(projectPath===undefined?{}:{projectPath})}),linearStatus:()=>request<LinearConnectionStatus>('linear_status'),linearConnect:(clientId:string)=>request<LinearStatus>('linear_connect',{clientId}),linearSync:(workspaceId?:string)=>request<LinearStatus>('linear_sync',workspaceId?{workspaceId}:undefined),linearDisconnect:(workspaceId?:string)=>request<LinearStatus>('linear_disconnect',workspaceId?{workspaceId}:undefined),start:()=>request<CaptureStatus>('start'),stop:()=>request<CaptureStatus>('stop'),settings:(settings:Partial<CaptureSettings>)=>request<CaptureStatus>('settings',settings)};
export interface ReviewAction {id:string;at:number;count:number;mode:'assigned'|'unassigned'|'clear'|'split';projectPath:string|null;undoneAt:number|null;eventIds:string[];}
export const reviewTransport={history:()=>request<ReviewAction[]>('review_history'),undo:(id:string)=>request<Summary>('review_undo',{id})};
export const splitTransport={save:(pairs:Array<[string,string]>,splitAt:number,beforeProject?:string,afterProject?:string)=>request<Summary>('human_group_split',{pairs,splitAt,...(beforeProject?{beforeProject}:{}),...(afterProject?{afterProject}:{})})};
export const rulePreviewTransport={preview:(pattern:string,projectPath:string)=>request<WebsiteRuleImpact>('website_rule_preview',{pattern,projectPath})};
export interface DayReviewStatus {date:string;completedAt:number|null;stale:boolean;hasActivity:boolean;unmatchedSeconds:number;conflicts:number;gaps:number;backlog:Array<{date:string;unmatchedSeconds:number;conflicts:number;gaps:number}>;}
export const dayReviewTransport={status:(date:string)=>request<DayReviewStatus>('day_review_status',{date}),mark:(date:string)=>request<DayReviewStatus>('day_review_mark',{date})};
export async function openAccessibilitySettings(){if(native){const {invoke}=await import('@tauri-apps/api/core');await invoke('open_accessibility_settings');}}
export async function openLinearOAuthSettings(){if(native){const {invoke}=await import('@tauri-apps/api/core');await invoke('open_linear_oauth_settings');}else window.open('https://linear.app/settings/api/applications/new','_blank','noopener,noreferrer');}
export async function startupItem(operation:'status'|'enable'|'disable'|'settings'):Promise<StartupItemStatus>{
 if(!native)throw new Error('Login item controls require the desktop app');
 const {invoke}=await import('@tauri-apps/api/core');return invoke<StartupItemStatus>('startup_item',{operation});
}

export function relaunchHookSetup(){window.dispatchEvent(new Event('agent-time:hook-setup'));}
