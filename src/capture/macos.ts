import { execFile,spawn,type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import {existsSync} from 'node:fs';
import {createInterface} from 'node:readline';
import { makeEvent, type CaptureEvent } from './events.ts';
import { object } from './orca.ts';
import {browserByBundle,browsers} from './sources/registry.ts';
import {browserProbeArguments} from './browser-probe.ts';
import type {CaptureSettings} from './settings.ts';
export function normalizeActivity(payload: unknown, context: Partial<CaptureEvent>):CaptureEvent {
  const p=object(payload);
  const good=typeof p.idleSeconds==='number'&&Number.isFinite(p.idleSeconds)&&p.idleSeconds>=0&&typeof p.uptime==='number'&&p.idleSeconds<=p.uptime+5;
  const browser=browserByBundle.has(String(p.foregroundBundleId));
  const domain=browser&&typeof p.browserDomain==='string'&&/^(?:localhost|::1|[a-z0-9-]+(?:\.[a-z0-9-]+)+)$/.test(p.browserDomain)&&p.browserDomain.length<=253?p.browserDomain:undefined;
  let browserUrl:string|undefined;
  if(domain&&typeof p.browserUrl==='string'&&p.browserUrl.length<=2048){
    try{const url=new URL(p.browserUrl);if(['http:','https:'].includes(url.protocol)&&url.hostname.replace(/^\[|\]$/g,'').replace(/^www\./,'')===domain&&!url.username&&!url.password)browserUrl=p.browserUrl;}catch{/* Invalid URL cannot be persisted. */}
  }
  return makeEvent('macos',p.kind==='sleep'?'sleep':p.kind==='wake'?'wake':'activity',{
    ...context,sourceAt:Number.isFinite(p.observedAt)?p.observedAt:undefined,
    data:{foregroundBundleId:typeof p.foregroundBundleId==='string'?p.foregroundBundleId:'unknown',
      foregroundName:typeof p.foregroundName==='string'?p.foregroundName:'Unknown app',
      idleSeconds:good?p.idleSeconds:null,idleStatus:good?'observed':'unknown',
      accessibilityTrusted:p.accessibilityTrusted===true,
      browserDomain:domain,browserOrigin:browserUrl?new URL(browserUrl).origin:undefined,browserUrl,browserTitle:browserUrl&&typeof p.browserTitle==='string'?p.browserTitle.slice(0,180):undefined,
      orcaWindowTitle:typeof p.orcaWindowTitle==='string'?p.orcaWindowTitle.slice(0,180):undefined,
      orcaSelectedTabTitle:typeof p.orcaSelectedTabTitle==='string'?p.orcaSelectedTabTitle.slice(0,180):undefined,
      orcaSelectedWorktreeId:typeof p.orcaSelectedWorktreeId==='string'?p.orcaSelectedWorktreeId.slice(0,1024):undefined},
  });
}
export async function probeCapabilities(executable:string):Promise<Record<string,unknown>> {
  const {stdout}=await promisify(execFile)(executable,['--trust-only'],{timeout:5000,maxBuffer:4096});
  return object(JSON.parse(stdout.trim()));
}
export class MacActivityProbe {
 private helper?:ChildProcess;private probeCheckAt=0;private probeRefresh?:Promise<void>;
 private executable:string|undefined;private settings:()=>CaptureSettings;private running:()=>boolean;private onLine:(line:string)=>void;private onError:(reason:string)=>void;private onMissing:()=>void;
 constructor(executable:string|undefined,settings:()=>CaptureSettings,running:()=>boolean,onLine:(line:string)=>void,onError:(reason:string)=>void,onMissing:()=>void){this.executable=executable;this.settings=settings;this.running=running;this.onLine=onLine;this.onError=onError;this.onMissing=onMissing;}
 get active(){return Boolean(this.helper);}
 start(){
  if(this.helper||!this.settings().macosActivity)return;
  if(!this.executable||!existsSync(this.executable)){this.onMissing();return;}
  const helper=spawn(this.executable,browserProbeArguments(browsers,this.settings()),{stdio:['ignore','pipe','pipe']});this.helper=helper;
  const lines=createInterface({input:helper.stdout!});
  lines.on('line',line=>{if(this.running()&&this.helper===helper&&this.settings().macosActivity)this.onLine(line);});
  helper.on('error',()=>{if(this.helper===helper)this.onError('macOS activity helper unavailable');});
  helper.on('exit',()=>{if(this.running()&&this.helper===helper){this.helper=undefined;this.onError('macOS helper exited');}});
 }
 stop(){const helper=this.helper;this.helper=undefined;helper?.kill('SIGTERM');}
 refreshTrust(current:Record<string,unknown>|null):Promise<void>|undefined{
  if(!this.running()||!this.settings().macosActivity||!this.executable||!existsSync(this.executable)||this.probeRefresh||Date.now()-this.probeCheckAt<15000||!current&&this.helper)return this.probeRefresh;
  this.probeCheckAt=Date.now();
  this.probeRefresh=probeCapabilities(this.executable).then(probe=>{
   if(!this.running()||!this.settings().macosActivity)return;
   if(this.helper&&current&&probe.accessibilityTrusted===Boolean(current.accessibilityTrusted))return;
   this.stop();this.start();
  }).catch(()=>{if(!this.helper)this.onError('macOS activity helper unavailable');}).finally(()=>{this.probeRefresh=undefined;});
  return this.probeRefresh;
 }
}
