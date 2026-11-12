import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {writeReport,writeTaskReport,currentWork,timeline,sessions,type Snapshot} from '../src/mcp/data.ts';
import {makeEvent,type Interval} from '../src/capture/events.ts';

test('generic attributes inherit, clear, and freeze across task retries',()=>{
 const output=mkdtempSync(join(tmpdir(),'generic-context-')),context=randomUUID(),who={provider:'codex',sessionId:'native'};
 try{
  writeReport(output,'work_context',randomUUID(),context,{attributes:{client:'one',ticket:'a'},agentIdentity:{id:'business'}},who);
  const id=randomUUID(),task=writeTaskReport(output,'task_start',id,context,{name:'Build',attributes:{ticket:'',phase:'test'}},who);
  assert.deepEqual(task.data?.attributes,{client:'one',phase:'test'});
  writeReport(output,'work_context',randomUUID(),context,{attributes:{client:'two'}},who);
  assert.deepEqual(writeTaskReport(output,'task_start',id,context,{name:'Build',attributes:{ticket:'',phase:'test'}},who).data,task.data);
  assert.deepEqual(currentWork(output).tasks[0]?.attributes,{client:'one',phase:'test'});
 }finally{rmSync(output,{recursive:true,force:true});}
});
const fixture=():Snapshot=>{
 const interval:Interval={start:100,end:140,state:'grouped',proof:'observed',sourceEventIds:[],provider:'codex',hostId:'one',sessionId:'native'};
 const events=[makeEvent('hook','session_start',{observedAt:90,provider:'codex',hostId:'one',sessionId:'native',data:{agentIdentity:{id:'worker'},agentProfile:'builder',attributes:{phase:'one'}}}),makeEvent('agent_report','work_context',{observedAt:120,provider:'codex',sessionId:'native',data:{attributes:{phase:'two'}}})];
 return {from:100,to:150,truncatedBefore:false,events,summary:{intervals:[interval,{...interval,hostId:'two',sessionId:'peer'}],sessions:[{key:'one',provider:'codex',hostId:'one',sessionId:'native',lastObservedAt:140,title:'',state:'stopped',seconds:60,observedSeconds:40,child:false,proof:'observed'}],coverage:[],unresolved:[],childAgentSeconds:0,humanSeconds:0,agentSeconds:120,elapsedSeconds:60}};
};
test('temporal contributors preserve metadata and unfiltered credit',()=>{
 const s=fixture(),all=timeline(s);
 assert.equal(all.totals.agentRunningSeconds,120);
 assert.equal(all.segments[0]?.contributors.length,2);
 assert.equal(all.contextSlices.length,3);
 assert.equal(all.contextSlices[0]?.observedSeconds,20);
 assert.equal(sessions(s,{agentIdentityId:'worker'}).sessions[0]?.agentIdentity?.id,'worker');
 assert.equal(timeline(s,undefined,{agentIdentityId:'worker'}).totals.agentRunningSeconds,60);
});

test('agent filters exclude unrelated human time and do not round context fragments',()=>{
 const s=fixture();s.summary.intervals=s.summary.intervals.slice(0,1);
 s.summary.intervals.push({start:100,end:140,state:'human',proof:'observed',sourceEventIds:[]});
 s.events.push(makeEvent('agent_report','work_context',{observedAt:110,provider:'codex',sessionId:'native',data:{agentIdentity:{id:'peer'}}}),makeEvent('agent_report','work_context',{observedAt:130,provider:'codex',sessionId:'native',data:{agentIdentity:{id:'worker'}}}));
 const filtered=timeline(s,undefined,{agentIdentityId:'worker'});
 assert.equal(filtered.totals.humanActiveSeconds,0);
 assert.equal(filtered.totals.agentRunningSeconds,30,'two ten-second fragments share their original sixty-second block');
 assert.equal(timeline(s).totals.agentRunningSeconds,60);
});

test('hostless business declarations cannot choose between equal native sessions on different hosts',()=>{
 const s=fixture();s.events=s.events.filter(e=>e.source!=='hook');s.events[0]!.data={agentIdentity:{id:'ambiguous'}};
 s.summary.intervals[1]!.sessionId='native';
 assert.equal(timeline(s,undefined,{agentIdentityId:'ambiguous'}).totals.agentRunningSeconds,0);
});

test('root agent profiles remain distinct from business identity',()=>{
 const s=fixture();const rows=sessions(s,{agentProfile:'builder'}).sessions;
 assert.equal(rows.length,1);assert.equal(rows[0]?.agentProfile,'builder');assert.equal(rows[0]?.agentIdentity?.id,'worker');
 s.events[0]!.data={childType:'reviewer'};
 assert.equal(sessions(s,{agentProfile:'reviewer'}).sessions.length,1);
 assert.equal(sessions(s,{agentIdentityId:'reviewer'}).sessions.length,0);
});

test('validator and pending spool use the same UTF8 report cap',async()=>{
 const {validAgentReport}=await import('../src/mcp/report.ts');
 const output=mkdtempSync(join(tmpdir(),'generic-context-bytes-'));
 try{
  const event=writeReport(output,'work_context',randomUUID(),randomUUID(),{project:'é'.repeat(500),task:'é'.repeat(170),agentIdentity:{id:'é'.repeat(128),name:'é'.repeat(128),role:'é'.repeat(128)},attributes:{payload:'é'.repeat(128)}},{provider:'codex',sessionId:'s'.repeat(128),workspaceId:'é'.repeat(500)});
  assert.ok(Buffer.byteLength(JSON.stringify(event))>2048);assert.equal(validAgentReport(event),true);
  assert.equal(currentWork(output).contexts.length,1);
  assert.equal(validAgentReport({...event,data:{...event.data,project:'界'.repeat(500)}}),false);
 }finally{rmSync(output,{recursive:true,force:true});}
});

test('weighted metadata selection remains one credit block across midnight',async()=>{
 const {PeriodTimeCredits}=await import('../src/mcp/time-credit.ts');
 const base={state:'grouped' as const,proof:'observed' as const,sourceEventIds:[],provider:'codex',sessionId:'s'};
 const credit=new PeriodTimeCredits();credit.add([{...base,start:90,end:95}],100,[{...base,start:90,end:100}]);
 credit.add([{...base,start:105,end:110}],200,[{...base,start:100,end:110}]);
 assert.equal(credit.totals().agentRunningSeconds,30);
 const defaultCredit=new PeriodTimeCredits();defaultCredit.add([{...base,start:90,end:100}],100);defaultCredit.add([{...base,start:100,end:110}],200);
 assert.equal(defaultCredit.totals().agentRunningSeconds,60);
});

test('old metadata anchors hydrate without replaying old measured time',async()=>{
 const {EventStore}=await import('../src/capture/store.ts');const {snapshot}=await import('../src/mcp/data.ts');
 const output=mkdtempSync(join(tmpdir(),'generic-context-anchor-')),store=new EventStore(join(output,'events.sqlite')),at=Date.now()/1000-300;
 const who={provider:'codex',sessionId:'old',hostId:'local',cwd:'/tmp/context-anchor'};
 try{
  store.put(makeEvent('hook','session_start',{...who,observedAt:at-3*86400,data:{agentIdentity:{id:'launcher'},attributes:{project:'launch'}}}));
  store.put(makeEvent('hook','tool_start',{...who,observedAt:at,data:{toolId:'tool'}}));
  store.put(makeEvent('hook','tool_end',{...who,observedAt:at+40,data:{toolId:'tool'}}));
  const s=snapshot(output,at-1,at+60);
  assert.equal(s.summary.agentSeconds,60);
  assert.equal(sessions(s,{agentIdentityId:'launcher'}).sessions[0]?.attributes?.project,'launch');
 }finally{store.close();rmSync(output,{recursive:true,force:true});}
});

test('actual daily project adapter applies identity/profile filters without changing default credit',async()=>{
 const {EventStore}=await import('../src/capture/store.ts');const {projectTimeForRange}=await import('../src/capture/billing-service.ts');
 const output=mkdtempSync(join(tmpdir(),'generic-context-project-')),store=new EventStore(join(output,'events.sqlite'));
 const date=new Date();date.setDate(date.getDate()-1);date.setHours(10,0,0,0);const at=date.getTime()/1000,day=`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
 const who={provider:'codex',sessionId:'daily',hostId:'local',cwd:'/tmp/context-daily'};
 try{
  store.put(makeEvent('hook','session_start',{...who,observedAt:at-1,data:{agentIdentity:{id:'worker'},agentProfile:'builder',attributes:{phase:'one'}}}));
  store.put(makeEvent('hook','tool_start',{...who,observedAt:at,data:{toolId:'tool'}}));
  store.put(makeEvent('agent_report','work_context',{...who,observedAt:at+20,data:{agentIdentity:{id:'peer'},attributes:{phase:'two'}}}));
  store.put(makeEvent('hook','tool_end',{...who,observedAt:at+40,data:{toolId:'tool'}}));
  const request={project:'/tmp/context-daily',fromDate:day,toDate:day,view:'details' as const};
  assert.equal(projectTimeForRange(output,request).agentRunningSeconds,60);
  const filtered=projectTimeForRange(output,{...request,agentIdentityId:'worker',agentProfile:'builder'});
  assert.equal(filtered.agentRunningSeconds,30);assert.equal(filtered.days[0]?.agentRunningSeconds,30);assert.equal(filtered.humanActiveSeconds,0);
  assert.ok(filtered.contextSlices.length);
 }finally{store.close();rmSync(output,{recursive:true,force:true});}
});

test('later repeated launcher hooks cannot overwrite explicit session declarations',()=>{
 const s=fixture();s.events.push(makeEvent('agent_report','work_context',{observedAt:110,provider:'codex',sessionId:'native',data:{agentIdentity:{id:'declared'},attributes:{phase:'declared'}}}));
 s.events.push(makeEvent('hook','tool_end',{observedAt:130,provider:'codex',hostId:'one',sessionId:'native',data:{agentIdentity:{id:'worker'},agentProfile:'builder',attributes:{phase:'one'}}}));
 const result=sessions(s,{agentIdentityId:'declared'}).sessions[0];
 assert.equal(result?.agentIdentity?.id,'declared');assert.equal(result?.attributes?.phase,'two','the latest explicit declaration remains later than declared, and still outranks repeated hooks');
 assert.equal(timeline(s,undefined,{agentIdentityId:'declared'}).totals.agentRunningSeconds,45);
});

test('billing evidence retains every human prompt when launcher metadata repeats',async()=>{
 const {EventStore}=await import('../src/capture/store.ts');const {snapshot}=await import('../src/mcp/data.ts');
 const output=mkdtempSync(join(tmpdir(),'generic-context-billing-prompts-')),store=new EventStore(join(output,'events.sqlite')),at=Date.now()/1000-300;
 try{
  for(const offset of [0,30,60])store.put(makeEvent('hook','prompt_submitted',{observedAt:at+offset,provider:'codex',hostId:'local',sessionId:'s',data:{humanInitiated:true,attributes:{client:'one'}}}));
  assert.equal(snapshot(output,at-1,at+100,{billingEvidence:true,persistedOnly:true}).events.filter(e=>e.kind==='prompt_submitted').length,3);
 }finally{store.close();rmSync(output,{recursive:true,force:true});}
});

test('task declaration anchors survive more than one thousand later launcher hooks',async()=>{
 const {EventStore}=await import('../src/capture/store.ts');
 const output=mkdtempSync(join(tmpdir(),'generic-context-many-hooks-')),store=new EventStore(join(output,'events.sqlite')),at=Date.now()/1000-2000;
 const who={provider:'codex',sessionId:'many',hostId:'local'},context=randomUUID();
 try{
  store.put(makeEvent('agent_report','work_context',{...who,observedAt:at,data:{contextId:context,agentIdentity:{id:'declared'},attributes:{client:'declared'}}}));
  for(let n=1;n<=1001;n++)store.put(makeEvent('hook','tool_end',{...who,observedAt:at+n,data:{agentIdentity:{id:'launcher'},attributes:{client:'launcher'}}}));
  const task=writeTaskReport(output,'task_start',randomUUID(),context,{name:'After many hooks'},who);
  assert.equal((task.data?.agentIdentity as {id:string})?.id,'declared');assert.deepEqual(task.data?.attributes,{client:'declared'});
 }finally{store.close();rmSync(output,{recursive:true,force:true});}
});

test('root tasks exclude metadata from native child hooks sharing the root session',async()=>{
 const {EventStore}=await import('../src/capture/store.ts');
 const output=mkdtempSync(join(tmpdir(),'generic-context-child-hook-')),store=new EventStore(join(output,'events.sqlite')),at=Date.now()/1000-100;
 const who={provider:'codex',sessionId:'parent',hostId:'local'};
 try{
  store.put(makeEvent('hook','session_start',{...who,observedAt:at,data:{agentIdentity:{id:'root'},attributes:{client:'root'}}}));
  store.put(makeEvent('hook','subagent_start',{...who,observedAt:at+1,agentId:'child',data:{agentIdentity:{id:'child'},attributes:{client:'child'}}}));
  const task=writeTaskReport(output,'task_start',randomUUID(),randomUUID(),{name:'Root'},who);
  assert.equal((task.data?.agentIdentity as {id:string})?.id,'root');assert.deepEqual(task.data?.attributes,{client:'root'});
 }finally{store.close();rmSync(output,{recursive:true,force:true});}
});

test('explicit task host cannot disambiguate a declaration that omitted its host',async()=>{
 const {EventStore}=await import('../src/capture/store.ts');
 const output=mkdtempSync(join(tmpdir(),'generic-context-hostless-task-')),store=new EventStore(join(output,'events.sqlite')),at=Date.now()/1000-100;
 const who={provider:'codex',sessionId:'same'},context=randomUUID();
 try{
  for(const hostId of ['one','two'])store.put(makeEvent('hook','session_start',{...who,hostId,observedAt:at,data:{agentIdentity:{id:hostId},attributes:{client:hostId}}}));
  store.put(makeEvent('agent_report','work_context',{...who,observedAt:at+1,data:{contextId:context,agentIdentity:{id:'ambiguous'},attributes:{client:'ambiguous'}}}));
  const task=writeTaskReport(output,'task_start',randomUUID(),context,{name:'Explicit host'},{...who,hostId:'one'});
  assert.equal((task.data?.agentIdentity as {id:string})?.id,'one');assert.deepEqual(task.data?.attributes,{client:'one'});
 }finally{store.close();rmSync(output,{recursive:true,force:true});}
});

test('filtered child timeline counts the same contributors whose time it credits',()=>{
 const s=fixture();s.summary.intervals=[{...s.summary.intervals[0]!,child:true,agentId:'child'}];
 s.events=[makeEvent('hook','subagent_start',{observedAt:90,provider:'codex',hostId:'one',sessionId:'native',agentId:'child',data:{childType:'Explore'}})];
 const view=timeline(s,undefined,{agentProfile:'Explore'});
 assert.equal(view.totals.agentRunningSeconds,60);assert.equal(view.segments.length,1);assert.equal(view.segments[0]?.agentCount,1);assert.equal(view.segments[0]?.contributors.length,1);
});

test('sessions explicitly flag context slices beyond the per-session bound',()=>{
 const s=fixture(),base=s.summary.intervals[0]!;
 s.summary.intervals=Array.from({length:101},(_,index)=>({...base,start:100+index*2,end:101+index*2}));
 const bounded=sessions(s,{}).sessions[0]!;
 assert.equal(bounded.contextSlices.length,100);assert.equal(bounded.moreContextSlices,true);
 s.summary.intervals=s.summary.intervals.slice(0,100);
 assert.equal(sessions(s,{}).sessions[0]?.moreContextSlices,false);
});
