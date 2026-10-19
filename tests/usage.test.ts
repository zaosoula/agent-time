import {test} from 'node:test';import assert from 'node:assert/strict';
import {parseUsage,tokenTotal,type ParserState} from '../src/usage/parser.ts';import {apiEquivalent} from '../src/usage/pricing.ts';
test('local usage scan does not call Orca when its CLI is unavailable',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {setTimeout:sleep}=await import('node:timers/promises');const {EventStore}=await import('../src/capture/store.ts');const {UsageReader}=await import('../src/usage/reader.ts');
 const root=mkdtempSync(join(tmpdir(),'ade-usage-no-orca-')),path=join(root,'events.sqlite'),previous=process.env.ORCA_CLI_COMMAND;
 process.env.ORCA_CLI_COMMAND=join(root,'missing-orca');const store=new EventStore(path);store.close();
 const reader=new UsageReader(path,[],undefined,'');
 try{
  reader.start();for(let i=0;i<100&&reader.summary().lastScan===null;i++)await sleep(20);
  assert.ok(reader.summary().lastScan);assert.equal(reader.summary().error,null);assert.deepEqual(reader.summary().limits,[]);
 }finally{
  await reader.close();rmSync(root,{recursive:true});
  if(previous===undefined)delete process.env.ORCA_CLI_COMMAND;else process.env.ORCA_CLI_COMMAND=previous;
 }
});
test('Claude usage identity deduplicates repeated message blocks and excludes transcript text',()=>{
 const e={type:'assistant',timestamp:'2026-10-12T12:00:00Z',sessionId:'s',requestId:'r',message:{id:'m',model:'claude-opus-5-5',content:[{text:'private prompt'}],usage:{input_tokens:10,output_tokens:20,cache_read_input_tokens:100,cache_creation_input_tokens:40,cache_creation:{ephemeral_1h_input_tokens:30},output_tokens_details:{thinking_tokens:5}}}};
 const a=parseUsage('claude',e,{},'a')!;assert.equal(a.id,parseUsage('claude',{...e,message:{...e.message,content:[]}}, {},'a')?.id);assert.equal(tokenTotal(a),170);assert.ok(!JSON.stringify(a).includes('private prompt'));
 assert.ok(Math.abs(apiEquivalent(a.model,a)!-(10*4+20*20+100*.2+10*5+30*8)/1e6)<1e-12);
});
test('Codex cumulative snapshots produce deltas without double-counting cached or reasoning tokens',()=>{
 const state:ParserState={sessionId:'s',model:'gpt-6.1-sol'};
 const e=(input:number,output:number)=>({type:'event_msg',timestamp:'2026-10-12T12:00:00Z',payload:{type:'token_count',info:{total_token_usage:{input_tokens:input,cached_input_tokens:50,output_tokens:output,reasoning_output_tokens:5}}}});
 const a=parseUsage('codex',e(100,10),state,'a')!;assert.equal(tokenTotal(a),110);assert.equal(a.input,50);assert.equal(a.reasoning,5);
 assert.equal(parseUsage('codex',e(100,10),state,'a'),undefined);const b=parseUsage('codex',e(120,15),state,'a')!;assert.equal(tokenTotal(b),25);
 assert.equal(apiEquivalent('unknown-model',a),null);
});
test('usage import persists cursors, retries partial lines, and ignores duplicate Claude blocks',async()=>{
 const {mkdtempSync,writeFileSync,appendFileSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {setTimeout:sleep}=await import('node:timers/promises');const {UsageReader}=await import('../src/usage/reader.ts');
 const root=mkdtempSync(join(tmpdir(),'ade-usage-')),file=join(root,'s.jsonl');
 const event=(id:string)=>({type:'assistant',timestamp:new Date().toISOString(),sessionId:'s',message:{id,model:'claude-opus-5-5',content:[{text:'private content'}],usage:{input_tokens:10,output_tokens:20,cache_read_input_tokens:100}}});
 const a=JSON.stringify(event('one')),b=JSON.stringify(event('two'));writeFileSync(file,a+'\n'+a+'\n'+b.slice(0,40));
 writeFileSync(join(root,'untracked.jsonl'),JSON.stringify({...event('untracked'),sessionId:'other'})+'\n');
 const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(join(root,'usage.sqlite'));db.exec('CREATE TABLE events (observed_at REAL,payload TEXT)');db.prepare('INSERT INTO events VALUES (?,?)').run(Date.now()/1000-10,JSON.stringify({source:'hook',provider:'claude',sessionId:'s'}));db.close();
 const reader=new UsageReader(join(root,'usage.sqlite'),[{provider:'claude',accountId:'a',path:root}],async()=>({ok:true,result:{rateLimits:{},claude:{},codex:{}}}), '');
 try{
  reader.start();for(let i=0;i<100&&reader.summary().scanning;i++)await sleep(10);assert.equal(reader.summary().days[0]?.tokens,130);
  appendFileSync(file,b.slice(40)+'\n');await reader.refresh();assert.equal(reader.summary().days[0]?.tokens,260);await reader.refresh();assert.equal(reader.summary().days[0]?.tokens,260);
  assert.ok(!JSON.stringify(reader.summary()).includes('private content'));
 }finally{await reader.close();rmSync(root,{recursive:true});}
});
test('provider usage switches skip disabled logs while retaining previously imported totals',async()=>{
 const {mkdtempSync,mkdirSync,writeFileSync,appendFileSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {setTimeout:sleep}=await import('node:timers/promises');const {DatabaseSync}=await import('node:sqlite');const {UsageReader}=await import('../src/usage/reader.ts');
 const root=mkdtempSync(join(tmpdir(),'ade-usage-provider-'));mkdirSync(join(root,'claude'));mkdirSync(join(root,'codex'));const timestamp=new Date().toISOString();
 writeFileSync(join(root,'claude/a.jsonl'),JSON.stringify({type:'assistant',timestamp,sessionId:'a',message:{id:'m',model:'claude-opus-5-5',usage:{input_tokens:10,output_tokens:20}}})+'\n');
 const counter=(n:number)=>({type:'event_msg',timestamp,payload:{type:'token_count',info:{total_token_usage:{input_tokens:n,output_tokens:0}}}});
 writeFileSync(join(root,'codex/b.jsonl'),[{type:'session_meta',timestamp,payload:{id:'b'}},{type:'turn_context',timestamp,payload:{model:'gpt-6.1-sol'}},counter(100)].map(e=>JSON.stringify(e)).join('\n')+'\n');
 const path=join(root,'usage.sqlite'),db=new DatabaseSync(path);db.exec('CREATE TABLE events(observed_at REAL,payload TEXT)');for(const [provider,sessionId] of [['claude','a'],['codex','b']])db.prepare('INSERT INTO events VALUES(?,?)').run(Date.now()/1000-10,JSON.stringify({source:'hook',provider,sessionId}));db.close();
 const reader=new UsageReader(path,[{provider:'claude',accountId:'a',path:join(root,'claude')},{provider:'codex',accountId:'b',path:join(root,'codex')}],async()=>({ok:true,result:{rateLimits:{},claude:{},codex:{}}}),'');
 try{
  reader.configureProviders({claude:false,codex:true});reader.start();for(let i=0;i<100&&reader.summary().scanning;i++)await sleep(10);
  assert.equal(reader.summary().days.find(d=>d.provider==='codex')?.tokens,100);assert.equal(reader.summary().days.find(d=>d.provider==='claude'),undefined);assert.equal(reader.summary().limits.some(l=>l.provider==='claude'),false);
  reader.configureProviders({claude:true,codex:false});appendFileSync(join(root,'codex/b.jsonl'),JSON.stringify(counter(200))+'\n');await reader.refresh();
  assert.equal(reader.summary().days.find(d=>d.provider==='claude')?.tokens,30);assert.equal(reader.summary().days.find(d=>d.provider==='codex')?.tokens,100);
 }finally{await reader.close();rmSync(root,{recursive:true});}
});
