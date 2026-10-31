import {createHash} from 'node:crypto';
import {makeEvent,type CaptureEvent} from '../events.ts';
import {object} from '../orca.ts';
import type {AgentSource} from './types.ts';
import type {ParserState,UsageRecord,Counts} from '../../usage/parser.ts';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
const common=['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','PermissionRequest','Stop','SessionEnd','SubagentStart','SubagentStop'];
const kinds:Record<string,string>={SessionStart:'session_start',SessionEnd:'session_end',UserPromptSubmit:'prompt_submitted',PreToolUse:'tool_start',PostToolUse:'tool_end',PostToolUseFailure:'tool_end',Stop:'response_stop',StopFailure:'interrupted',SubagentStart:'child_start',SubagentStop:'child_stop',PermissionRequest:'waiting'};
const text=(value:unknown)=>typeof value==='string'?value.slice(0,512):undefined;
const count=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0?Math.floor(value):0;
function normalizeHook(payload:unknown,context:Partial<CaptureEvent>):CaptureEvent{
 const p=object(payload),name=String(p.hook_event_name||'unknown');
 return makeEvent('hook',kinds[name]||'unknown',{...context,provider:'claude',sessionId:text(p.session_id),turnId:text(p.turn_id),agentId:text(p.agent_id),cwd:text(p.cwd)||context.cwd,data:{hook:name,toolId:text(p.tool_use_id),toolName:text(p.tool_name),source:text(p.source),childType:text(p.agent_type),stopBlocked:p.stop_hook_active===true}});
}
function parseUsage(e:any,state:ParserState,accountId:string):UsageRecord|undefined{
 const timestamp=Date.parse(e.timestamp)/1000;if(!Number.isFinite(timestamp))return;
 const m=e.message,u=m?.usage;if(e.type!=='assistant'||!u||!m.id)return;
 const c:Counts={input:count(u.input_tokens),output:count(u.output_tokens),cacheRead:count(u.cache_read_input_tokens),cacheWrite:count(u.cache_creation_input_tokens),cacheWrite1h:count(u.cache_creation?.ephemeral_1h_input_tokens),reasoning:count(u.output_tokens_details?.thinking_tokens)};
 return {...c,id:createHash('sha256').update(JSON.stringify(['claude',m.id])).digest('hex'),provider:'claude',sessionId:String(e.sessionId||state.sessionId||''),model:String(m.model||'unknown'),timestamp,cwd:typeof e.cwd==='string'?e.cwd:undefined,accountId};
}
export default {kind:'agent',id:'claude',name:'Claude Code',setting:'claudeHooks',usageSetting:'claudeTokenUsage',defaultEnabled:true,configDirectory:'.claude',configFile:'settings.json',configEnv:'CLAUDE_CONFIG_DIR',orcaDirectories:['claude-accounts','claude-profiles'],discoverAccount:(root:string)=>[root,join(root,'home')].filter(folder=>existsSync(join(folder,'settings.json'))||existsSync(join(folder,'projects'))),hookEvents:[...common,'PostToolUseFailure','StopFailure'],legacyConfigSuffix:'.claude/settings.local.json',normalizeHook,parseUsage,defaultUsagePath:'.claude/projects',usagePaths:['projects','home/projects'],dedupe:'max',childSessionIds:false,orcaLimits:true} satisfies AgentSource;
