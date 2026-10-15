import {createHash} from 'node:crypto';
import {makeEvent,type CaptureEvent} from '../events.ts';
import {object} from '../orca.ts';
import type {AgentSource} from './types.ts';
import type {ParserState,UsageRecord,Counts} from '../../usage/parser.ts';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
const common=['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','PermissionRequest','Stop','SessionEnd','SubagentStart','SubagentStop'];
const kinds:Record<string,string>={SessionStart:'session_start',SessionEnd:'session_end',UserPromptSubmit:'prompt_submitted',PreToolUse:'tool_start',PostToolUse:'tool_end',Stop:'response_stop',Interrupt:'interrupted',SubagentStart:'child_start',SubagentStop:'child_stop',PermissionRequest:'waiting'};
const text=(value:unknown)=>typeof value==='string'?value.slice(0,512):undefined;
const count=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0?Math.floor(value):0;
function normalizeHook(payload:unknown,context:Partial<CaptureEvent>):CaptureEvent{
 const p=object(payload),name=String(p.hook_event_name||'unknown');
 return makeEvent('hook',kinds[name]||'unknown',{...context,provider:'codex',sessionId:text(p.session_id),turnId:text(p.turn_id),agentId:text(p.agent_id),cwd:text(p.cwd)||context.cwd,data:{hook:name,toolId:text(p.tool_use_id),toolName:text(p.tool_name),source:text(p.source),childType:text(p.agent_type),stopBlocked:p.stop_hook_active===true}});
}
function parseUsage(e:any,state:ParserState,accountId:string):UsageRecord|undefined{
 const timestamp=Date.parse(e.timestamp)/1000;if(!Number.isFinite(timestamp))return;
 const p=e.payload;if(e.type==='session_meta'){state.sessionId=p?.id;state.cwd=p?.cwd;return;}
 if(e.type==='turn_context'){state.model=p?.model;state.cwd=p?.cwd||state.cwd;return;}
 if(e.type!=='event_msg'||p?.type!=='token_count'||!p.info?.total_token_usage)return;
 const total=p.info.total_token_usage,previous=state.previous||{},reset=Object.keys(previous).some(k=>count(total[k])<count(previous[k]));
 const delta=(k:string)=>Math.max(0,count(total[k])-(reset?0:count(previous[k])));
 const cached=delta('cached_input_tokens'),writes=delta('cache_write_input_tokens'),input=delta('input_tokens');
 const c:Counts={input:Math.max(0,input-cached-writes),output:delta('output_tokens'),cacheRead:cached,cacheWrite:writes,cacheWrite1h:0,reasoning:delta('reasoning_output_tokens')};
 state.previous=Object.fromEntries(Object.entries(total).map(([k,v])=>[k,count(v)]));if(!Object.values(c).some(n=>n>0))return;
 return {...c,id:createHash('sha256').update(JSON.stringify(['codex',state.sessionId,timestamp,total])).digest('hex'),provider:'codex',sessionId:state.sessionId||'',model:state.model||'unknown',timestamp,cwd:state.cwd,accountId};
}
export default {kind:'agent',id:'codex',name:'Codex',setting:'codexHooks',usageSetting:'codexTokenUsage',defaultEnabled:true,configDirectory:'.codex',configFile:'hooks.json',configEnv:'CODEX_HOME',discoverAccount:(root:string)=>existsSync(join(root,'home'))?[join(root,'home')]:[],hookEvents:[...common,'Interrupt'],legacyConfigSuffix:'.codex/hooks.json',trustNote:'Start a new Codex session after changes and review the Agent Time hooks in /hooks.',normalizeHook,parseUsage,defaultUsagePath:'.codex/sessions',usagePaths:['home/sessions'],dedupe:'first',childSessionIds:true,orcaLimits:true} satisfies AgentSource;
