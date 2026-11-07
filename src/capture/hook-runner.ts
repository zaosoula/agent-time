// Standalone installed entrypoint: no collector or account reads.
import {parseArgs} from 'node:util';
import {normalizeHook,hookContext,spoolHook,hookInstallationId} from './hooks.ts';
import {agentById} from './sources/agent-registry.ts';
try{
 const {values}=parseArgs({options:{provider:{type:'string'},spool:{type:'string'},'installation-id':{type:'string'},'runtime-version':{type:'string'},'self-test':{type:'boolean'}},strict:true});
 if(values['self-test']){console.log(JSON.stringify({ok:true,node:process.version}));}
 else{
  const chunks:Buffer[]=[];let bytes=0;
  for await(const chunk of process.stdin){bytes+=chunk.length;if(bytes>262144)break;chunks.push(chunk);}
  if(bytes<=262144&&agentById.has(values.provider||'')&&values.spool&&values['runtime-version']){
   const payload=JSON.parse(Buffer.concat(chunks).toString());
   // Older installs pass --installation-id; current ones derive it from the running config.
   const installation=values['installation-id']||hookInstallationId(values.provider!,payload);
   spoolHook(normalizeHook(values.provider!,payload,{...hookContext(),...(installation?{runtimeId:`${installation}/${values['runtime-version']}`}:{})}),values.spool);
  }
 }
}catch{} // Never fail the agent's operation or return conversation context.
