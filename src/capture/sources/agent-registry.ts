import {readdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import type {AgentSource} from './types.ts';

const directory=fileURLToPath(new URL('.',import.meta.url));
export async function loadAgents(folder=directory):Promise<AgentSource[]>{
 const names=readdirSync(folder).filter(name=>name.endsWith('.agent.ts')).sort(),agents:AgentSource[]=[],ids=new Set<string>();
 for(const name of names){
  const agent=(await import(pathToFileURL(join(folder,name)).href)).default as AgentSource;
  if(!agent||agent.kind!=='agent'||typeof agent.id!=='string'||!/^[a-z][a-z0-9]*$/.test(agent.id)||ids.has(agent.id)||agent.setting!==`${agent.id}Hooks`||agent.usageSetting!==`${agent.id}TokenUsage`||typeof agent.normalizeHook!=='function'||typeof agent.parseUsage!=='function'||typeof agent.discoverAccount!=='function'||!Array.isArray(agent.hookEvents)||!Array.isArray(agent.usagePaths))throw new Error(`Invalid agent source: ${name}`);
  ids.add(agent.id);agents.push(agent);
 }
 return agents;
}
export const agents=await loadAgents();
export const agentById=new Map(agents.map(agent=>[agent.id,agent]));
