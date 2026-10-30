import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('stdio MCP negotiates with legacy clients and exposes bounded local tools',async()=>{
 const output=mkdtempSync(join(tmpdir(),'agent-time-mcp-stdio-'));
 const child=spawn(process.execPath,['src/mcp/server.ts'],{cwd:process.cwd(),env:{...process.env,ADE_CAPTURE_OUTPUT:output},stdio:['pipe','pipe','pipe']});
 const replies=new Map<number,Record<string,unknown>>();
 let resolve!:()=>void;
 const done=new Promise<void>(r=>{resolve=r;});
 const timeout=setTimeout(()=>{child.kill();resolve();},5000);
 createInterface({input:child.stdout}).on('line',line=>{
  const payload=JSON.parse(line) as Record<string,unknown>;
  if(typeof payload.id==='number')replies.set(payload.id,payload);
  if(replies.has(1)&&replies.has(2)&&replies.has(3))resolve();
 });
 const send=(message:Record<string,unknown>)=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',...message})+'\n');
 try{
  send({id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'fixture',version:'1'}}});
  send({method:'notifications/initialized'});
  send({id:2,method:'tools/list',params:{}});
  send({id:3,method:'tools/call',params:{name:'current_work',arguments:{}}});
  await done;
  assert.equal((replies.get(1)?.result as {serverInfo?:{name?:string}})?.serverInfo?.name,'agent-time');
  const tools=(replies.get(2)?.result as {tools?:Array<{name:string}>})?.tools||[];
  assert.deepEqual(['time_for_issue','time_for_project','timeline','sessions','coverage','unattributed','explain_attribution','current_work','set_work_context','start_task','stop_task','report_port_state'].every(name=>tools.some(tool=>tool.name===name)),true);
  assert.equal((replies.get(3)?.result as {content?:Array<{text:string}>})?.content?.[0]?.text.includes('"tasks":[]'),true);
 }finally{clearTimeout(timeout);child.kill();rmSync(output,{recursive:true,force:true});}
});
