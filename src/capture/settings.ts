export interface CaptureSettings {
  macosActivity:boolean;browserSafari:boolean;browserChrome:boolean;browserBrave:boolean;claudeHooks:boolean; codexHooks:boolean; orcaPolling:boolean;tokenUsage:boolean;claudeTokenUsage:boolean;codexTokenUsage:boolean;
  humanIdleMinutes:number;agentIdleMinutes:number;
}
export const defaultSettings:CaptureSettings={macosActivity:true,browserSafari:true,browserChrome:true,browserBrave:true,claudeHooks:true,codexHooks:true,orcaPolling:true,tokenUsage:false,claudeTokenUsage:true,codexTokenUsage:true,humanIdleMinutes:5,agentIdleMinutes:5};
export const browserSettings={
  'com.apple.Safari':'browserSafari',
  'com.google.Chrome':'browserChrome',
  'com.brave.Browser':'browserBrave',
} as const;
export function browserEnabled(settings:CaptureSettings,bundleId:unknown):boolean{
  const key=browserSettings[bundleId as keyof typeof browserSettings];
  return key?settings[key]:false;
}
export function storedSettings(value:Record<string,unknown>):CaptureSettings{
  const legacy=value.browserTracking;
  const initial={...defaultSettings};
  if(typeof legacy==='boolean')for(const key of Object.values(browserSettings))initial[key]=legacy;
  const known=Object.fromEntries(Object.keys(defaultSettings).filter(key=>key in value).map(key=>[key,value[key]]));
  return {...initial,...validateSettings(known)};
}
export function validateSettings(value:unknown):Partial<CaptureSettings> {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid capture settings');
  for(const [key,enabled] of Object.entries(value))
    if(key==='humanIdleMinutes'||key==='agentIdleMinutes'){
      if(!Number.isInteger(enabled)||Number(enabled)<1||Number(enabled)>60)throw new Error('Invalid capture setting: '+key);
    }else if(!Object.hasOwn(defaultSettings,key)||typeof enabled!=='boolean')throw new Error('Invalid capture setting: '+key);
  return value as Partial<CaptureSettings>;
}
