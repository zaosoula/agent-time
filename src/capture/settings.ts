import {browsers,browserByBundle,sources} from './sources/registry.ts';
import type {CaptureSource} from './sources/types.ts';
export interface CaptureSettings {
  macosActivity:boolean;browserSafari:boolean;browserChrome:boolean;browserBrave:boolean;claudeHooks:boolean; codexHooks:boolean; orcaPolling:boolean;tokenUsage:boolean;claudeTokenUsage:boolean;codexTokenUsage:boolean;
  humanIdleMinutes:number;agentIdleMinutes:number;
  [key:string]:boolean|number;
}
export function settingsForSources(sources:CaptureSource[]):Record<string,boolean|number>{return {macosActivity:true,tokenUsage:false,humanIdleMinutes:5,agentIdleMinutes:5,
  ...Object.fromEntries(sources.map(source=>[source.setting,source.defaultEnabled])),
  ...Object.fromEntries(sources.filter(source=>source.kind==='agent').map(source=>[source.usageSetting,true]))};}
export const defaultSettings=settingsForSources(sources) as unknown as CaptureSettings;
export const browserSettings=Object.fromEntries(browsers.map(source=>[source.bundleId,source.setting])) as Record<string,string>;
export function browserEnabled(settings:CaptureSettings,bundleId:unknown):boolean{
  const source=browserByBundle.get(String(bundleId));return source?settings[source.setting]===true:false;
}
export function storedSettings(value:Record<string,unknown>):CaptureSettings{
  const legacy=value.browserTracking;
  const initial={...defaultSettings};
  if(typeof legacy==='boolean')for(const key of Object.values(browserSettings))initial[key]=legacy;
  const known=Object.fromEntries(Object.keys(defaultSettings).filter(key=>key in value).map(key=>[key,value[key]]));
  return {...initial,...validateSettings(known)} as CaptureSettings;
}
export function validateSettings(value:unknown,defaults:Record<string,boolean|number>=defaultSettings):Partial<CaptureSettings> {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid capture settings');
  for(const [key,enabled] of Object.entries(value))
    if(key==='humanIdleMinutes'||key==='agentIdleMinutes'){
      if(!Number.isInteger(enabled)||Number(enabled)<1||Number(enabled)>60)throw new Error('Invalid capture setting: '+key);
    }else if(!Object.hasOwn(defaults,key)||typeof enabled!=='boolean')throw new Error('Invalid capture setting: '+key);
  return value as Partial<CaptureSettings>;
}
