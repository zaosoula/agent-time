import type {CaptureEvent} from '../events.ts';
import type {ParserState,UsageRecord} from '../../usage/parser.ts';
import type {EventStore} from '../store.ts';
import type {FocusedOrcaTab} from '../orca-focus.ts';
import type {AccessibilityCapture} from '../health.ts';

export interface BrowserSource {
  kind:'browser';id:string;name:string;detail:string;bundleId:string;setting:string;defaultEnabled:boolean;order?:number;
  titleSuffix?:string;
}
export interface AgentSource {
  kind:'agent';id:string;name:string;setting:string;usageSetting:string;defaultEnabled:boolean;
  configDirectory:string;configFile:string;configEnv:string;
  discoverAccount(root:string):string[];
  hookEvents:string[];legacyConfigSuffix?:string;
  trustNote?:string;
  normalizeHook(payload:unknown,context:Partial<CaptureEvent>):CaptureEvent;
  parseUsage(event:any,state:ParserState,accountId:string):UsageRecord|undefined;
  defaultUsagePath:string;usagePaths:string[];dedupe:'first'|'max';childSessionIds:boolean;orcaLimits?:boolean;
}
export interface PollSource {
  kind:'poller';id:string;name:string;setting:string;defaultEnabled:boolean;
  poll(context:{reader:(argv:string[])=>Promise<unknown>;runId?:string;valid:()=>boolean;store:EventStore}):Promise<string|null>;
  foreground?(payload:Record<string,any>,event:CaptureEvent,focusedTabs:FocusedOrcaTab[],focusedTabsAt:number):{attribution:Record<string,unknown>|null;accessibility:AccessibilityCapture}|null;
}
export type CaptureSource=BrowserSource|AgentSource|PollSource;
