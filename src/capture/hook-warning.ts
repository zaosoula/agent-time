import type {HookInstallationStatus,HookTarget} from './hook-installation.ts';
import type {CaptureSettings} from './settings.ts';

export function outdatedHookTargets(status:{running:boolean;surfaces:CaptureSettings}|null,hooks:HookInstallationStatus|null):HookTarget[]{
 if(!status?.running||!hooks)return [];
 const enabled=new Set(hooks.agents.filter(agent=>status.surfaces[agent.setting]===true).map(agent=>agent.id));
 return hooks.targets.filter(target=>enabled.has(target.provider)&&target.state==='needs-update');
}
