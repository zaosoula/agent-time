import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { makeEvent, type CaptureEvent } from './events.ts';
import { object } from './orca.ts';
export function normalizeActivity(payload: unknown, context: Partial<CaptureEvent>):CaptureEvent {
  const p=object(payload);
  const good=typeof p.idleSeconds==='number'&&Number.isFinite(p.idleSeconds)&&p.idleSeconds>=0&&typeof p.uptime==='number'&&p.idleSeconds<=p.uptime+5;
  const browser=['com.apple.Safari','com.google.Chrome','com.brave.Browser'].includes(String(p.foregroundBundleId));
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
