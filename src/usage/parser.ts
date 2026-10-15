import {agentById} from '../capture/sources/agent-registry.ts';
export interface Counts{input:number;output:number;cacheRead:number;cacheWrite:number;cacheWrite1h:number;reasoning:number;}
export interface UsageRecord extends Counts{id:string;provider:string;sessionId:string;model:string;timestamp:number;cwd?:string;accountId:string;}
export interface ParserState{sessionId?:string;model?:string;cwd?:string;previous?:Record<string,number>;}
export function parseUsage(provider:string,e:any,state:ParserState,accountId:string):UsageRecord|undefined{
 return agentById.get(provider)?.parseUsage(e,state,accountId);
}
export const tokenTotal=(c:Counts)=>c.input+c.output+c.cacheRead+c.cacheWrite;
