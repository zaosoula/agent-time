import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

test('real MCP client declares canonical attributes and discovers explicit agent filters',async()=>{
 const output=mkdtempSync(join(tmpdir(),'generic-context-stdio-'));
 const child=spawn(process.execPath,['src/mcp/server.ts'],{cwd:process.cwd(),env:{...process.env,ADE_CAPTURE_OUTPUT:output},stdio:['pipe','pipe','pipe']});
 let next=1;const pending=new Map<number,(reply:any)=>void>();
 createInterface({input:child.stdout}).on('line',line=>{const reply=JSON.parse(line);pending.get(reply.id)?.(reply);});
 const rpc=(method:string,params:unknown)=>new Promise<any>((resolve,reject)=>{const id=next++;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`${method} timed out`));},5000);pending.set(id,reply=>{clearTimeout(timer);pending.delete(id);resolve(reply);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
 const call=async(name:string,args:Record<string,unknown>)=>{const reply=await rpc('tools/call',{name,arguments:args});assert.equal(reply.error,undefined);assert.notEqual(reply.result?.isError,true,JSON.stringify(reply));return JSON.parse(reply.result.content[0].text);};
 try{
  await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'generic-context',version:'1'}});
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  const tools=(await rpc('tools/list',{})).result.tools;
  for(const name of ['sessions','timeline','time_for_project']){const properties=tools.find((tool:any)=>tool.name===name).inputSchema.properties;assert.ok(properties.agentIdentityId);assert.ok(properties.agentProfile);}
  const who={provider:'codex',sessionId:'native',hostId:'local'};
  await call('set_work_context',{...who,agentIdentity:{id:'business'},attributes:{CLIENT:'one',ticket:'a'}});
  const id=randomUUID(),args={...who,requestId:id,name:'Build',attributes:{ticket:'',phase:'verify'}};
  const task=await call('start_task',args);assert.deepEqual(task.attributes,{client:'one',phase:'verify'});assert.equal(task.agentIdentity.id,'business');
  await call('set_work_context',{...who,attributes:{client:'two'}});
  assert.deepEqual((await call('start_task',args)).attributes,task.attributes);
 }finally{child.kill();rmSync(output,{recursive:true,force:true});}
});
