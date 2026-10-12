export interface CaptureSettings {
  macosActivity:boolean; claudeHooks:boolean; codexHooks:boolean; orcaPolling:boolean;tokenUsage:boolean;claudeTokenUsage:boolean;codexTokenUsage:boolean;
}
export const defaultSettings:CaptureSettings={macosActivity:true,claudeHooks:true,codexHooks:true,orcaPolling:true,tokenUsage:false,claudeTokenUsage:true,codexTokenUsage:true};
export function validateSettings(value:unknown):Partial<CaptureSettings> {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid capture settings');
  for(const [key,enabled] of Object.entries(value))
    if(!Object.hasOwn(defaultSettings,key)||typeof enabled!=='boolean')throw new Error('Invalid capture setting: '+key);
  return value as Partial<CaptureSettings>;
}
