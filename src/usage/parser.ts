import {createHash} from 'node:crypto';
export interface Counts{input:number;output:number;cacheRead:number;cacheWrite:number;cacheWrite1h:number;reasoning:number;}
export interface UsageRecord extends Counts{id:string;provider:string;sessionId:string;model:string;timestamp:number;cwd?:string;accountId:string;}
export interface ParserState{sessionId?:string;model?:string;cwd?:string;previous?:Record<string,number>;}
const count=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>=0?Math.floor(v):0;
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function parseUsage(provider:string,e:any,state:ParserState,accountId:string):UsageRecord|undefined{
 const timestamp=Date.parse(e.timestamp)/1000;if(!Number.isFinite(timestamp))return;
 if(provider==='claude'){
  const m=e.message,u=m?.usage;if(e.type!=='assistant'||!u||!m.id)return;
  const c:Counts={input:count(u.input_tokens),output:count(u.output_tokens),cacheRead:count(u.cache_read_input_tokens),cacheWrite:count(u.cache_creation_input_tokens),cacheWrite1h:count(u.cache_creation?.ephemeral_1h_input_tokens),reasoning:count(u.output_tokens_details?.thinking_tokens)};
  return {...c,id:hash(['claude',m.id]),provider,sessionId:String(e.sessionId||state.sessionId||''),model:String(m.model||'unknown'),timestamp,cwd:typeof e.cwd==='string'?e.cwd:undefined,accountId};
 }
 const p=e.payload;
 if(e.type==='session_meta'){state.sessionId=p?.id;state.cwd=p?.cwd;return;}
 if(e.type==='turn_context'){state.model=p?.model;state.cwd=p?.cwd||state.cwd;return;}
 if(e.type!=='event_msg'||p?.type!=='token_count'||!p.info?.total_token_usage)return;
 const total=p.info.total_token_usage,previous=state.previous||{};const reset=Object.keys(previous).some(k=>count(total[k])<count(previous[k]));
 const delta=(k:string)=>Math.max(0,count(total[k])-(reset?0:count(previous[k])));
 const cached=delta('cached_input_tokens'),writes=delta('cache_write_input_tokens'),input=delta('input_tokens');
 const c:Counts={input:Math.max(0,input-cached-writes),output:delta('output_tokens'),cacheRead:cached,cacheWrite:writes,cacheWrite1h:0,reasoning:delta('reasoning_output_tokens')};
 state.previous=Object.fromEntries(Object.entries(total).map(([k,v])=>[k,count(v)]));
 if(!Object.values(c).some(n=>n>0))return;
 return {...c,id:hash(['codex',state.sessionId,timestamp,total]),provider,sessionId:state.sessionId||'',model:state.model||'unknown',timestamp,cwd:state.cwd,accountId};
}
export const tokenTotal=(c:Counts)=>c.input+c.output+c.cacheRead+c.cacheWrite;
