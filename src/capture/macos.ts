import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { makeEvent, type CaptureEvent } from './events.ts';
import { object } from './orca.ts';
export function normalizeActivity(payload: unknown, context: Partial<CaptureEvent>):CaptureEvent {
  const p=object(payload);
  const good=typeof p.idleSeconds==='number'&&Number.isFinite(p.idleSeconds)&&p.idleSeconds>=0&&typeof p.uptime==='number'&&p.idleSeconds<=p.uptime+5;
  return makeEvent('macos',p.kind==='sleep'?'sleep':p.kind==='wake'?'wake':'activity',{
    ...context,sourceAt:Number.isFinite(p.observedAt)?p.observedAt:undefined,
    data:{foregroundBundleId:typeof p.foregroundBundleId==='string'?p.foregroundBundleId:'unknown',
      foregroundName:typeof p.foregroundName==='string'?p.foregroundName:'Unknown app',
      idleSeconds:good?p.idleSeconds:null,idleStatus:good?'observed':'unknown',
      accessibilityTrusted:p.accessibilityTrusted===true,
      orcaWindowTitle:typeof p.orcaWindowTitle==='string'?p.orcaWindowTitle.slice(0,180):undefined},
  });
}
export async function probeCapabilities(executable:string):Promise<Record<string,unknown>> {
  const {stdout}=await promisify(execFile)(executable,['--once'],{timeout:5000,maxBuffer:65536});
  return object(JSON.parse(stdout.trim()));
}
