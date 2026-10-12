import type { Summary } from '../capture/events.ts';
export interface CaptureStatus { running:boolean;orcaPolling:boolean;lastPoll:number|null;lastError:string|null;eventCount:number;output:string;macos:Record<string,unknown>|null; }
export const native=Boolean('__TAURI_INTERNALS__' in window);
export async function request<T>(method:string,params:Record<string,unknown>={}):Promise<T>{
 if(native){const {invoke}=await import('@tauri-apps/api/core');return invoke<T>('capture_request',{method,params});}
 const response=await fetch('/__capture',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:crypto.randomUUID(),method,params})});
 if(!response.ok)throw new Error('Local collector unavailable. Start the app or the development server.');
 const reply=await response.json();if(reply.error)throw new Error(reply.error);return reply.result as T;
}
export const transport={status:()=>request<CaptureStatus>('status'),summary:()=>request<Summary>('summary'),start:(durationSeconds=86400)=>request<CaptureStatus>('start',{durationSeconds}),stop:()=>request<CaptureStatus>('stop')};
