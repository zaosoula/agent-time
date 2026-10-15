// Standalone installed entrypoint: no collector or account reads.
import {parseArgs} from 'node:util';
import {normalizeHook,hookContext,spoolHook} from './hooks.ts';
import {agentById} from './sources/agent-registry.ts';
try{
 const {values}=parseArgs({options:{provider:{type:'string'},spool:{type:'string'},'installation-id':{type:'string'},'runtime-version':{type:'string'},'self-test':{type:'boolean'}},strict:true});
 if(values['self-test']){console.log(JSON.stringify({ok:true,node:process.version}));}
 else{
  const chunks:Buffer[]=[];let bytes=0;
  for await(const chunk of process.stdin){bytes+=chunk.length;if(bytes>262144)break;chunks.push(chunk);}
  if(bytes<=262144&&agentById.has(values.provider||'')&&values.spool&&values['installation-id']&&values['runtime-version']){
   spoolHook(normalizeHook(values.provider!,JSON.parse(Buffer.concat(chunks).toString()),{...hookContext(),runtimeId:`${values['installation-id']}/${values['runtime-version']}`}),values.spool);
  }
 }
}catch{} // Never fail the agent's operation or return conversation context.
