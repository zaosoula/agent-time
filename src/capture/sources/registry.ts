import {readdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import type {CaptureSource,BrowserSource,AgentSource,PollSource} from './types.ts';

const directory=fileURLToPath(new URL('.',import.meta.url));
export async function loadSources(folder=directory):Promise<CaptureSource[]>{
 const names=readdirSync(folder).filter(name=>/\.(agent|browser|poller)\.ts$/.test(name)).sort();
 const sources:CaptureSource[]=[];const ids=new Set<string>(),bundles=new Set<string>(),settings=new Set<string>();
 for(const name of names){
  const source=(await import(pathToFileURL(join(folder,name)).href)).default as CaptureSource;
  if(!source||!['browser','agent','poller'].includes(source.kind)||typeof source.id!=='string'||!/^[a-z][a-z0-9-]{0,40}$/.test(source.id)||ids.has(source.id)||typeof source.name!=='string'||!source.name||source.name.length>80||typeof source.defaultEnabled!=='boolean'||typeof source.setting!=='string'||settings.has(source.setting))throw new Error(`Invalid capture source: ${name}`);
  if(source.kind==='browser'&&(typeof source.bundleId!=='string'||!/^[A-Za-z0-9.-]+$/.test(source.bundleId)||bundles.has(source.bundleId)||typeof source.detail!=='string'))throw new Error(`Invalid browser source: ${name}`);
  if(source.kind==='browser'&&!/^browser[A-Z][A-Za-z0-9]*$/.test(source.setting)||source.kind==='agent'&&(!/^[a-z][a-z0-9]*$/.test(source.id)||source.setting!==`${source.id}Hooks`||source.usageSetting!==`${source.id}TokenUsage`||typeof source.normalizeHook!=='function'||typeof source.parseUsage!=='function'||!Array.isArray(source.hookEvents)||!Array.isArray(source.usagePaths)||typeof source.discoverAccount!=='function')||source.kind==='poller'&&(source.setting!==`${source.id}Polling`||typeof source.poll!=='function'))throw new Error(`Invalid source contract: ${name}`);
  ids.add(source.id);settings.add(source.setting);if(source.kind==='browser')bundles.add(source.bundleId);else if(source.kind==='agent'){if(settings.has(source.usageSetting))throw new Error(`Duplicate source setting: ${name}`);settings.add(source.usageSetting);}
  sources.push(source);
 }
 return sources;
}
export const sources=await loadSources();
export const browsers=sources.filter((source):source is BrowserSource=>source.kind==='browser').sort((a,b)=>(a.order??100)-(b.order??100)||a.id.localeCompare(b.id));
export const agents=sources.filter((source):source is AgentSource=>source.kind==='agent');
export const pollers=sources.filter((source):source is PollSource=>source.kind==='poller');
export const browserByBundle=new Map(browsers.map(source=>[source.bundleId,source]));
export const agentById=new Map(agents.map(source=>[source.id,source]));
export const pollerById=new Map(pollers.map(source=>[source.id,source]));
export const sourceMetadata=[...agents,...browsers,...pollers].map(source=>source.kind==='browser'?{kind:source.kind,id:source.id,name:source.name,detail:source.detail,setting:source.setting,defaultEnabled:source.defaultEnabled,bundleId:source.bundleId}:source.kind==='agent'?{kind:source.kind,id:source.id,name:source.name,setting:source.setting,defaultEnabled:source.defaultEnabled,usageSetting:source.usageSetting}:{kind:source.kind,id:source.id,name:source.name,setting:source.setting,defaultEnabled:source.defaultEnabled});
