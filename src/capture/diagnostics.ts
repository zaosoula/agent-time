import type {RecoveryNotice} from './recovery.ts';
interface DiagnosticInput {
 status:{running:boolean;eventCount:number;lastPoll:number|null;lastError:string|null;surfaces:Record<string,unknown>;sources:Array<{id:string;kind:string;setting:string}>};
 health:{latest:Record<string,number|null>;hooks:Record<string,{installed:number;total:number;needsAttention:boolean}>;spool?:{pending:number;temporary:number;invalid:number;oldestAgeSeconds:number|null;truncated:boolean}};
 hooks:{runtimeReady:boolean;targets:Array<{provider:string;state:string}>};
 databaseBytes:number;databaseHealthy:boolean;now:number;recovery?:RecoveryNotice[];
}
const age=(at:number|null|undefined,now:number)=>typeof at==='number'&&Number.isFinite(at)?Math.max(0,Math.floor(now-at)):null;
const errorCategory=(error:string|null)=>!error?null:/permission|accessibility|denied/i.test(error)?'permission':/sqlite|database|disk/i.test(error)?'storage':/network|connect|timeout/i.test(error)?'connection':'other';
export function diagnosticSummary({status,health,hooks,databaseBytes,databaseHealthy,now,recovery=[]}:DiagnosticInput){
 return {
  checkedAt:now,running:status.running,eventCount:status.eventCount,
  lastPollAgeSeconds:age(status.lastPoll,now),errorCategory:errorCategory(status.lastError),
  runtimeReady:hooks.runtimeReady,databaseBytes,databaseHealth:databaseHealthy===true?'ok':'needs-attention',spool:health.spool||null,recovery,
  sources:status.sources.filter(source=>/^[a-z][a-z0-9-]*$/.test(source.id)).map(source=>{
   const owned=hooks.targets.filter(target=>target.provider===source.id);
   const hookState=source.kind==='agent'?(owned.some(target=>target.state==='error'||target.state==='needs-update')?'needs-attention':owned.length&&owned.every(target=>target.state==='installed')?'installed':'not-installed'):null;
   return {id:source.id,kind:source.kind,enabled:status.surfaces[source.setting]===true,lastEventAgeSeconds:age(health.latest[source.id],now),hooks:hookState};
  }),
 };
}

export type DiagnosticSummary=ReturnType<typeof diagnosticSummary>;
