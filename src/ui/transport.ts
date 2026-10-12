import type { Summary } from '../capture/events.ts';
import type { CaptureSettings } from '../capture/settings.ts';
import type {HookInstallationStatus,HookProvider,TrackingCleanupPreview,TrackingCleanupResult} from '../capture/hook-installation.ts';
import type {UsageSummary} from '../usage/reader.ts';
export interface CaptureStatus { running:boolean;orcaPolling:boolean;surfaces:CaptureSettings;lastPoll:number|null;lastError:string|null;eventCount:number;output:string;macos:Record<string,unknown>|null; }
export const native=Boolean('__TAURI_INTERNALS__' in window);
export async function request<T>(method:string,params:Record<string,unknown>={}):Promise<T>{
 if(native){const {invoke}=await import('@tauri-apps/api/core');return invoke<T>('capture_request',{method,params});}
 const response=await fetch('/__capture',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:crypto.randomUUID(),method,params})});
 if(!response.ok)throw new Error('Local collector unavailable. Start the app or the development server.');
 const reply=await response.json();if(reply.error)throw new Error(reply.error);return reply.result as T;
}
export const transport={cleanupPreview:()=>request<TrackingCleanupPreview>('tracking_cleanup_preview'),cleanupTracking:()=>request<TrackingCleanupResult>('tracking_cleanup',{confirmed:true}),hooksStatus:()=>request<HookInstallationStatus>('hooks_status'),verifyHooks:()=>request<HookInstallationStatus>('hooks_verify'),installHooks:(provider:HookProvider)=>request<HookInstallationStatus>('hooks_install',{provider}),dismissHookSetup:()=>request<HookInstallationStatus>('hooks_dismiss'),status:()=>request<CaptureStatus>('status'),summary:()=>request<Summary>('summary'),usage:()=>request<UsageSummary>('usage'),start:(durationSeconds=86400)=>request<CaptureStatus>('start',{durationSeconds}),stop:()=>request<CaptureStatus>('stop'),settings:(settings:Partial<CaptureSettings>)=>request<CaptureStatus>('settings',settings)};
export async function openAccessibilitySettings(){if(native){const {invoke}=await import('@tauri-apps/api/core');await invoke('open_accessibility_settings');}}

export function relaunchHookSetup(){window.dispatchEvent(new Event('agent-time:hook-setup'));}
