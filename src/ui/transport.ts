import type { Summary } from '../capture/events.ts';
import type { CaptureSettings } from '../capture/settings.ts';
import type {HookInstallationStatus,HookProvider,TrackingCleanupPreview,TrackingCleanupResult} from '../capture/hook-installation.ts';
import type {UsageSummary} from '../usage/reader.ts';
import type {CaptureHealth} from '../capture/health.ts';
import type {DiagnosticSummary} from '../capture/diagnostics.ts';
import type {WebsiteResolution,WebsiteRule} from '../capture/website-resolver.ts';
import type {LinearStatus} from '../capture/linear.ts';
export interface LinearConnectionStatus extends LinearStatus {repositoryMatches:Record<string,string[]>;}
export interface WebsiteProjectStatus {rules:WebsiteRule[];projects:string[];matches:WebsiteResolution[];}
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
export const transport={cleanupPreview:()=>request<TrackingCleanupPreview>('tracking_cleanup_preview'),cleanupTracking:()=>request<TrackingCleanupResult>('tracking_cleanup',{confirmed:true}),hooksStatus:()=>request<HookInstallationStatus>('hooks_status'),verifyHooks:()=>request<HookInstallationStatus>('hooks_verify'),installHooks:(provider:HookProvider)=>request<HookInstallationStatus>('hooks_install',{provider}),dismissHookSetup:()=>request<HookInstallationStatus>('hooks_dismiss'),status:()=>request<CaptureStatus>('status'),summary:(date:string)=>request<Summary>('summary',{date}),captureHealth:()=>request<CaptureHealth>('capture_health'),diagnostics:()=>request<DiagnosticSummary>('diagnostics'),usage:()=>request<UsageSummary>('usage'),websiteProjects:()=>request<WebsiteProjectStatus>('website_projects'),setWebsiteRule:(pattern:string,projectPath:string)=>request<WebsiteProjectStatus>('website_rule_set',{pattern,projectPath}),removeWebsiteRule:(pattern:string)=>request<WebsiteProjectStatus>('website_rule_remove',{pattern}),setHumanDecision:(pairs:Array<[string,string]>,mode:'assigned'|'unassigned'|'clear',projectPath?:string)=>request<Summary>('human_decision_set',{pairs,mode,...(projectPath===undefined?{}:{projectPath})}),linearStatus:()=>request<LinearConnectionStatus>('linear_status'),linearConnect:(clientId:string)=>request<LinearStatus>('linear_connect',{clientId}),linearSync:(workspaceId?:string)=>request<LinearStatus>('linear_sync',workspaceId?{workspaceId}:undefined),linearDisconnect:(workspaceId?:string)=>request<LinearStatus>('linear_disconnect',workspaceId?{workspaceId}:undefined),start:()=>request<CaptureStatus>('start'),stop:()=>request<CaptureStatus>('stop'),settings:(settings:Partial<CaptureSettings>)=>request<CaptureStatus>('settings',settings)};
export async function openAccessibilitySettings(){if(native){const {invoke}=await import('@tauri-apps/api/core');await invoke('open_accessibility_settings');}}
export async function openLinearOAuthSettings(){if(native){const {invoke}=await import('@tauri-apps/api/core');await invoke('open_linear_oauth_settings');}else window.open('https://linear.app/settings/api/applications/new','_blank','noopener,noreferrer');}
export async function startupItem(operation:'status'|'enable'|'disable'|'settings'):Promise<StartupItemStatus>{
 if(!native)throw new Error('Login item controls require the desktop app');
 const {invoke}=await import('@tauri-apps/api/core');return invoke<StartupItemStatus>('startup_item',{operation});
}

export function relaunchHookSetup(){window.dispatchEvent(new Event('agent-time:hook-setup'));}
