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
  assert.match(String((replies.get(1)?.result as {instructions?:string})?.instructions),/set_work_context[\s\S]*start_task[\s\S]*stop_task/);
  const tools=(replies.get(2)?.result as {tools?:Array<{name:string}>})?.tools||[];
  assert.deepEqual(['time_for_issue','time_for_project','timeline','sessions','coverage','unattributed','explain_attribution','current_work','set_work_context','start_task','stop_task','report_resource','report_port_state'].every(name=>tools.some(tool=>tool.name===name)),true);
  assert.equal((replies.get(3)?.result as {content?:Array<{text:string}>})?.content?.[0]?.text.includes('"tasks":[]'),true);
 }finally{clearTimeout(timeout);child.kill();rmSync(output,{recursive:true,force:true});}
});

test('MCP client can declare free references, inherited projects, agents, child tasks and own-task costs',async()=>{
 const {randomUUID}=await import('node:crypto');
 const output=mkdtempSync(join(tmpdir(),'agent-time-mcp-task-client-'));
 const child=spawn(process.execPath,['src/mcp/server.ts'],{cwd:process.cwd(),env:{...process.env,ADE_CAPTURE_OUTPUT:output},stdio:['pipe','pipe','pipe']});
 let next=1;const pending=new Map<number,(reply:any)=>void>();
 createInterface({input:child.stdout}).on('line',line=>{const reply=JSON.parse(line);pending.get(reply.id)?.(reply);});
 const rpc=(method:string,params:unknown)=>new Promise<any>((resolve,reject)=>{const id=next++;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Timed out: ${method}`));},5000);pending.set(id,reply=>{clearTimeout(timer);pending.delete(id);resolve(reply);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
 const call=async(name:string,args:Record<string,unknown>)=>{const reply=await rpc('tools/call',{name,arguments:args});assert.equal(reply.error,undefined);assert.notEqual(reply.result?.isError,true,JSON.stringify(reply));return JSON.parse(reply.result.content[0].text);};
 try{
  await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'fixture',version:'1'}});child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  await call('set_work_context',{project:'KANZen',issueKey:'T-9716',agentIdentity:{id:'cto',name:'CTO'},billable:true,provider:'claude',sessionId:'native-cto'});
  const id=randomUUID();const task=await call('start_task',{requestId:id,name:'TVA',provider:'claude',sessionId:'native-cto'});
  assert.equal(task.project,'KANZen');assert.equal(task.issueKey,'T-9716');assert.equal(task.measured,false);assert.equal(task.heartbeatEverySeconds,300);
  const heartbeat=await call('heartbeat_task',{taskCounterId:task.taskCounterId});assert.equal(heartbeat.taskCounterId,id);
  const sub=await call('start_task',{name:'Verify',parentTaskCounterId:id,agentIdentity:{id:'cfo'},provider:'claude',sessionId:'native-cfo'});
  assert.equal(sub.project,'KANZen');assert.equal(sub.parentTaskCounterId,id);assert.equal(sub.agentIdentity.id,'cfo');
  await call('stop_task',{taskCounterId:sub.taskCounterId,outcome:'failed'});
  await call('stop_task',{taskCounterId:id,usage:{inputTokens:100,outputTokens:20,cost:0.02,currency:'USD',source:'provider-response'}});
  const date=new Date(),localDate=`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  const history=await call('task_history',{fromDate:localDate,toDate:localDate,issueKey:'T-9716'});
  assert.equal(history.tasks.length,2);assert.equal(history.tasks.find((t:any)=>t.id===id).usage.cost,0.02);assert.equal(history.tasks.find((t:any)=>t.id===id).billable,true);
  const work=await call('current_work',{});assert.equal(work.tasks.length,0);
 }finally{child.kill();rmSync(output,{recursive:true,force:true});}
});

test('MCP billing resolves database projects, supports long summaries and exports saved reports',async()=>{
 const {EventStore}=await import('../src/capture/store.ts');const {BillingStore}=await import('../src/capture/billing-store.ts');
 const output=mkdtempSync(join(tmpdir(),'agent-time-mcp-billing-'));const store=new EventStore(join(output,'events.sqlite'));
 new BillingStore(store.database).saveProject({id:'client',name:'Client',aliases:['short'],sources:{repositories:['/fixture/client'],workspaceIds:[],reportedProjects:[]},timezone:'Europe/Paris',policies:[{id:'v1',effectiveFrom:'2026-01-01',basis:'overlapMergedWall',currency:'EUR',hourlyRate:'100',agentOnlyHourlyRate:null,agentWeight:'1',rounding:{minutes:1,mode:'nearest',scope:'period'},dailyCapMinutes:null,presenceWindowMinutes:null,aiFees:{mode:'none'}}]});
 const child=spawn(process.execPath,['src/mcp/server.ts'],{cwd:process.cwd(),env:{...process.env,ADE_CAPTURE_OUTPUT:output},stdio:['pipe','pipe','pipe']});
 let next=1;const pending=new Map<number,(reply:any)=>void>();createInterface({input:child.stdout}).on('line',line=>{const r=JSON.parse(line);pending.get(r.id)?.(r);});
 const rpc=(method:string,params:unknown)=>new Promise<any>((resolve,reject)=>{const id=next++;const timer=setTimeout(()=>reject(new Error(method+' timed out')),10000);pending.set(id,r=>{clearTimeout(timer);pending.delete(id);resolve(r);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
 const call=async(name:string,args:unknown)=>{const r=await rpc('tools/call',{name,arguments:args});assert.equal(r.error,undefined);assert.notEqual(r.result?.isError,true,JSON.stringify(r));return JSON.parse(r.result.content[0].text);};
 try{
 await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'fixture',version:'1'}});child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
 assert.equal((await call('billing_projects',{})).projects[0].id,'client');
 const result=await call('billing_for_project',{project:'short',fromDate:'2026-10-01',toDate:'2026-10-31',detail:'daily'});assert.equal(result.report.days.length,31);assert.equal(result.report.projectSnapshot,undefined);
 const exported=await call('billing_for_project',{project:'short',fromDate:'2026-10-01',toDate:'2026-10-31',reportId:result.report.reportId,format:'markdown'});assert.ok(exported.export.path.endsWith('.md'));
 const summary=await call('time_for_project',{project:'short',fromDate:'2026-10-01',toDate:'2026-11-01',view:'summary'});assert.equal(summary.days.length,31);assert.equal(summary.moreDays,true);
 }finally{child.kill();store.close();rmSync(output,{recursive:true,force:true});}
});
