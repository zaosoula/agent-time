import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,readFileSync,existsSync,utimesSync,readdirSync} from 'node:fs';
import {spawn,spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {Collector} from '../src/capture/collector.ts';
import {EventStore} from '../src/capture/store.ts';
import {makeEvent,type CaptureEvent} from '../src/capture/events.ts';
import {normalizeHook,spoolHook,importSpool,spoolStatus} from '../src/capture/hooks.ts';
import {clearStaleLock,processStartTime} from '../src/capture/capture-lock.ts';
import {readFleet,FleetCache} from '../src/capture/orca.ts';
import {groupIntervals} from '../src/capture/correlate.ts';
import {dispatchRequest} from '../src/capture/protocol.ts';
import {prepareConfig,hookTimeoutSeconds} from '../src/capture/hook-config.ts';
import {WebsiteResolver} from '../src/capture/website-resolver.ts';

const messages={unreadable:'unreadable',live:'live'};
const localDay=(seconds:number)=>{const d=new Date(seconds*1000);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
const sample=(id:string,at:number):CaptureEvent=>({eventId:id,source:'macos',kind:'activity',observedAt:at,monotonicAt:at,collectorEpoch:'epoch',data:{idleSeconds:0,foregroundBundleId:'com.example.Editor'}});

test('a capture lock names its owner by start time, so a reused PID is not a live collector',async()=>{
 const root=mkdtempSync(join(tmpdir(),'ade-lock-')),lock=join(root,'capture.lock');
 const child=spawn('/bin/sleep',['10']);
 try{
  await sleep(100);
  const started=processStartTime(child.pid!);assert.ok(started);
  writeFileSync(lock,JSON.stringify({pid:child.pid,started}));
  assert.throws(()=>clearStaleLock(lock,messages),/live/);
  // Same PID, another process start: the owner is gone.
  writeFileSync(lock,JSON.stringify({pid:child.pid,started:'Thu Jan  1 00:00:00 2000'}));
  clearStaleLock(lock,messages);assert.equal(existsSync(lock),false);
  // Legacy bare PID: a process started after the lock was written cannot own it.
  writeFileSync(lock,String(child.pid));utimesSync(lock,new Date('2001-01-01'),new Date('2001-01-01'));
  clearStaleLock(lock,messages);assert.equal(existsSync(lock),false);
  writeFileSync(lock,String(child.pid));
  assert.throws(()=>clearStaleLock(lock,messages),/live/);
  // EPERM (another user's process, here launchd) means alive, not an error.
  writeFileSync(lock,'1');
  assert.throws(()=>clearStaleLock(lock,messages),/live/);
  writeFileSync(lock,'not a pid');
  assert.throws(()=>clearStaleLock(lock,messages),/unreadable/);
 }finally{child.kill();rmSync(root,{recursive:true,force:true});}
});

test('collector starts over a stale lock left by a reused PID',async()=>{
 const root=mkdtempSync(join(tmpdir(),'ade-lock-start-')),child=spawn('/bin/sleep',['10']);
 const c=new Collector(root);
 try{
  c.updateSettings({macosActivity:false,orcaPolling:false,tokenUsage:false});
  await sleep(100);
  writeFileSync(join(root,'capture.lock'),JSON.stringify({pid:child.pid,started:'Thu Jan  1 00:00:00 2000'}));
  const status=await c.start(5);assert.equal(status.running,true);
  assert.equal(JSON.parse(readFileSync(join(root,'capture.lock'),'utf8')).pid,process.pid);
 }finally{child.kill();await c.close();rmSync(root,{recursive:true,force:true});}
});

test('spool import sets bad records aside, survives one failing write, batches and bounds each drain',()=>{
 const root=mkdtempSync(join(tmpdir(),'ade-spool-audit-')),store=new EventStore(':memory:');
 try{
  for(let i=0;i<5;i++)spoolHook(normalizeHook('claude',{hook_event_name:'SessionStart',session_id:`s${i}`},{}),root);
  writeFileSync(join(root,'00-broken.json'),'{');
  writeFileSync(join(root,'old.tmp'),'partial');utimesSync(join(root,'old.tmp'),new Date(Date.now()-2*3600_000),new Date(Date.now()-2*3600_000));
  writeFileSync(join(root,'new.tmp'),'partial');
  // A record whose ID already holds different content is rejected, not retried forever.
  const original=normalizeHook('claude',{hook_event_name:'SessionStart',session_id:'conflict'},{});store.put(original);
  writeFileSync(join(root,'01-conflict.json'),JSON.stringify({...original,kind:'session_end'}));
  const issues=importSpool(root,store,()=>true,3);
  assert.deepEqual(issues.map(issue=>issue.reason).sort(),['Conflicting event record: 01-conflict.json','Unreadable event record: 00-broken.json']);
  assert.equal(store.count(),2,'the limit admits three records per drain');
  assert.ok(existsSync(join(root,'rejected','00-broken.json')));assert.ok(existsSync(join(root,'rejected','01-conflict.json')));
  assert.equal(existsSync(join(root,'old.tmp')),false);assert.equal(existsSync(join(root,'new.tmp')),true);
  assert.equal(spoolStatus(root).pending,4);
  // A storage failure keeps the failing record and those after it queued.
  const put=store.put.bind(store);let calls=0;
  (store as any).put=(event:CaptureEvent)=>{if(++calls===2)throw new Error('disk I/O error');return put(event);};
  assert.throws(()=>importSpool(root,store),/disk I\/O/);
  assert.equal(store.count(),3);assert.equal(spoolStatus(root).pending,3);
  (store as any).put=put;
  assert.deepEqual(importSpool(root,store),[]);assert.equal(store.count(),6);assert.equal(spoolStatus(root).pending,0);
 }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('token usage keeps its file cursor when saving records fails',async()=>{
 const {UsageReader}=await import('../src/usage/reader.ts');const {DatabaseSync}=await import('node:sqlite');
 const root=mkdtempSync(join(tmpdir(),'ade-usage-fail-')),file=join(root,'s.jsonl'),path=join(root,'usage.sqlite');
 writeFileSync(file,JSON.stringify({type:'assistant',timestamp:new Date().toISOString(),sessionId:'s',message:{id:'m1',model:'claude-opus-5-5',usage:{input_tokens:10,output_tokens:20}}})+'\n');
 const db=new DatabaseSync(path);db.exec('CREATE TABLE events (observed_at REAL,payload TEXT)');db.prepare('INSERT INTO events VALUES (?,?)').run(Date.now()/1000-10,JSON.stringify({source:'hook',provider:'claude',sessionId:'s'}));
 const reader=new UsageReader(db,[{provider:'claude',accountId:'a',path:root}],async()=>({ok:true,result:{rateLimits:{},claude:{},codex:{}}}),'');
 try{
  db.exec("CREATE TRIGGER fail BEFORE INSERT ON usage_events BEGIN SELECT RAISE(ABORT,'simulated full disk'); END");
  reader.start();for(let i=0;i<100&&reader.summary().lastScan===null;i++)await sleep(10);
  assert.match(reader.summary().error||'',/simulated full disk/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM usage_cursors').get()?.n,0,'the cursor did not advance past unsaved records');
  db.exec('DROP TRIGGER fail');await reader.refresh();
  assert.equal(reader.summary().days[0]?.tokens,30);
 }finally{await reader.close();db.close();rmSync(root,{recursive:true,force:true});}
});

test('an ongoing Orca failure is stored once, not on every poll',async()=>{
 const root=mkdtempSync(join(tmpdir(),'ade-coverage-dedupe-'));let polls=0;
 const c=new Collector(root,undefined,1,undefined,async argv=>{if(argv[1]==='run-list')polls++;throw new Error('Orca is not running');});
 try{
  c.updateSettings({macosActivity:false,tokenUsage:false});
  await c.start(10);
  for(let i=0;i<80&&polls<3;i++)await sleep(50);
  assert.ok(polls>=3);
  const notices=c.store.events().filter(event=>event.source==='orca'&&event.kind==='coverage'&&String(event.data?.reason).includes('Orca is not running'));
  assert.equal(notices.length,1);
 }finally{await c.close();rmSync(root,{recursive:true,force:true});}
});

test('fleet reads skip quiet Runs and list only the newest page between full listings',async()=>{
 const calls:string[][]=[];
 const worker=(run:string,fresh:boolean,outcome?:string)=>({runId:run,dispatchId:`d-${run}`,projection:{evidence:{liveStatus:fresh?'fresh':'stale'},outcome}});
 const reader=async(argv:string[])=>{
  calls.push(argv);
  if(argv[1]==='run-list')return argv.includes('--cursor')?{ok:true,result:{runs:[{id:'done'}],nextCursor:null}}:{ok:true,result:{runs:[{id:'active'},{id:'done'}],nextCursor:'page-2'}};
  const run=argv[argv.indexOf('--run')+1];
  return {ok:true,result:{workers:[run==='active'?worker(run,true):worker(run!,false,'succeeded')],page:{hasMore:false}}};
 };
 const cache=new FleetCache(),now=Date.now();
 await readFleet(reader,()=>true,cache,now);
 assert.equal(calls.filter(argv=>argv[1]==='run-list').length,2,'the first read lists every page');
 calls.length=0;
 const second=await readFleet(reader,()=>true,cache,now+5000);
 assert.deepEqual(calls.filter(argv=>argv[1]==='run-list').map(argv=>argv.includes('--cursor')),[false]);
 assert.deepEqual(calls.filter(argv=>argv[1]==='worker-list').map(argv=>argv[argv.indexOf('--run')+1]),['active']);
 assert.equal(second.workers.length,1);
 calls.length=0;
 await readFleet(reader,()=>true,cache,now+6*60_000);
 assert.deepEqual(calls.filter(argv=>argv[1]==='worker-list').map(argv=>argv[argv.indexOf('--run')+1]).sort(),['active','done'],'settled Runs are re-read slowly to notice reuse');
});

test('website resolutions are reused until the port owner changes',async()=>{
 const output=mkdtempSync(join(tmpdir(),'ade-website-cache-')),project=join(output,'project');mkdirSync(project);
 let owner=100;const calls:string[]=[];
 const run=async(file:string,args:string[])=>{
  calls.push([file,...args].join(' '));
  if(file==='/usr/sbin/lsof'&&args.includes('-sTCP:LISTEN'))return `p${owner}\ncnode\nn127.0.0.1:4173`;
  if(file==='/usr/sbin/lsof')return `n${project}`;
  if(file==='/bin/ps'&&args.includes('ppid='))return '1';
  if(file==='/bin/ps')return 'node vite';
  if(file==='/usr/bin/git'&&args.includes('--show-toplevel'))return project;
  return null;
 };
 try{
  const resolver=new WebsiteResolver(output,run);
  assert.equal((await resolver.resolve('http://localhost:4173/a',[]))?.projectPath,project);
  const first=calls.length;calls.length=0;
  assert.equal((await resolver.resolve('http://localhost:4173/b',[]))?.projectPath,project);
  assert.equal(calls.length,1,'a cached local page costs one listener check');assert.ok(first>calls.length);
  owner=200;calls.length=0;
  await resolver.resolve('http://localhost:4173/c',[]);
  assert.ok(calls.length>2,'a new port owner is resolved again');
 }finally{rmSync(output,{recursive:true,force:true});}
});

test('indexed grouping matches the direct blocker scan',()=>{
 let seed=7;const random=()=>{seed=(seed*1103515245+12345)%2147483648;return seed/2147483648;};
 const direct=(intervals:Array<[number,number]>,maxGap:number,blockers:Array<[number,number]>)=>{
  const grouped:Array<[number,number]>=[];
  for(const [start,end] of [...intervals].sort((a,b)=>a[0]-b[0])){const last=grouped.at(-1);if(last&&start-last[1]<=maxGap&&!blockers.some(([from,to])=>from<start&&to>last[1]))last[1]=Math.max(last[1],end);else grouped.push([start,end]);}
  return grouped;
 };
 for(let round=0;round<200;round++){
  const intervals=Array.from({length:20},()=>{const start=random()*2000;return [start,start+random()*90] as [number,number];});
  const blockers=Array.from({length:8},()=>{const at=random()*2000;return random()<.5?[at,at] as [number,number]:[at,at+random()*120] as [number,number];});
  assert.deepEqual(groupIntervals(intervals,60,blockers),direct(intervals,60,blockers));
 }
});

test('quiet providers find recent hooks through the provider index',()=>{
 const store=new EventStore(':memory:');
 try{
  const plan=store.database.prepare("EXPLAIN QUERY PLAN SELECT payload FROM events WHERE json_extract(payload,'$.source')='hook' AND json_extract(payload,'$.provider')=? ORDER BY rowid DESC LIMIT ?").all('codex',24).map(row=>String(row.detail)).join(' ');
  assert.match(plan,/events_hook_provider/);
  store.put(makeEvent('hook','session_start',{provider:'claude',sessionId:'a'}));
  assert.equal(store.recent('hook',24,'claude').length,1);assert.equal(store.recent('hook',24,'codex').length,0);
 }finally{store.close();}
});

test('review edits return the edited day, or the day the request names',async()=>{
 const root=mkdtempSync(join(tmpdir(),'ade-review-day-')),c=new Collector(root);
 try{
  const first=new Date('2026-10-20T10:00:00').getTime()/1000,second=new Date('2026-10-21T10:00:00').getTime()/1000;
  for(const [id,at] of [['a',first],['b',first+5],['c',second],['d',second+5]] as const)c.store.put(sample(id,at));
  const day=c.setHumanDecision([['a','b']],'unassigned');
  assert.ok(day.intervals.length>0&&day.intervals.every(interval=>localDay(interval.start)==='2026-10-20'),'the day the activity belongs to');
  assert.equal(day.intervals.find(interval=>interval.state==='human')?.userAttribution,'unassigned');
  const named=c.setHumanDecision([['a','b']],'clear',undefined,'2026-10-21');
  assert.ok(named.intervals.every(interval=>localDay(interval.start)==='2026-10-21'));
  assert.throws(()=>c.setHumanDecision([['a','b']],'clear',undefined,'2026-02-30'),/Invalid summary date/);
  const undo=c.reviewHistory()[0]!;
  assert.ok(c.undoReviewAction(undo.id).intervals.every(interval=>localDay(interval.start)==='2026-10-20'));
 }finally{await c.close();rmSync(root,{recursive:true,force:true});}
});

test('review requests accept an optional summary date',async()=>{
 const seen:unknown[]=[];
 const c={status:()=>({}),summary:()=>({}),start:async()=>({}),stop:async()=>({}),
  setHumanDecision:(...args:unknown[])=>{seen.push(args);return 'ok';},
  undoReviewAction:(...args:unknown[])=>{seen.push(args);return 'ok';},
  setHumanGroupSplit:(...args:unknown[])=>{seen.push(args);return 'ok';}};
 const id='00000000-0000-0000-0000-000000000000';
 assert.deepEqual(await dispatchRequest({id:'1',method:'human_decision_set',params:{pairs:[['a','b']],mode:'unassigned',date:'2026-10-20'}},c),{id:'1',result:'ok'});
 assert.deepEqual(await dispatchRequest({id:'2',method:'review_undo',params:{id,date:'2026-10-20'}},c),{id:'2',result:'ok'});
 assert.deepEqual(await dispatchRequest({id:'3',method:'human_group_split',params:{pairs:[['a','b']],splitAt:10,date:'2026-10-20'}},c),{id:'3',result:'ok'});
 assert.deepEqual(await dispatchRequest({id:'4',method:'review_undo',params:{id}},c),{id:'4',result:'ok'});
 assert.deepEqual(seen,[[[['a','b']],'unassigned',undefined,'2026-10-20'],[id,'2026-10-20'],[[['a','b']],10,undefined,undefined,'2026-10-20'],[id,undefined]]);
 for(const [method,params] of [['human_decision_set',{pairs:[['a','b']],mode:'unassigned',date:'today'}],['review_undo',{id,date:20261020}],['human_group_split',{pairs:[['a','b']],splitAt:10,date:'2026/10/20'}]] as const)
  assert.ok('error' in await dispatchRequest({id:'x',method,params},c));
});

test('damaged settings and privacy exclusions are set aside and reported instead of stopping capture',async()=>{
 const root=mkdtempSync(join(tmpdir(),'ade-corrupt-settings-'));
 writeFileSync(join(root,'settings.json'),'{"macosActivity":');writeFileSync(join(root,'privacy-exclusions.json'),'[{"kind":"app"}]');
 const c=new Collector(root);
 try{
  const status=c.status();
  assert.equal(status.surfaces.macosActivity,true);
  assert.equal(status.startupIssues.length,2);
  assert.ok(existsSync(join(root,'settings.json.corrupt')));assert.ok(existsSync(join(root,'privacy-exclusions.json.corrupt')));
  assert.deepEqual(c.privacyExclusions(),[]);
  c.updateSettings({macosActivity:false});assert.equal(JSON.parse(readFileSync(join(root,'settings.json'),'utf8')).macosActivity,false);
 }finally{await c.close();rmSync(root,{recursive:true,force:true});}
});

test('a storage replacement that cannot be applied leaves the sidecar starting normally',()=>{
 const root=mkdtempSync(join(tmpdir(),'ade-pending-start-'));
 try{
  new EventStore(join(root,'events.sqlite')).close();
  writeFileSync(join(root,'pending-storage-replacement.json'),'{"candidate":"damaged"}');
  const result=spawnSync(process.execPath,[resolve('src/capture/cli.ts'),'protocol','--output',root],{input:JSON.stringify({id:'1',method:'status'})+'\n',encoding:'utf8',timeout:20000});
  assert.match(result.stderr,/Pending storage replacement was not applied/);
  const response=JSON.parse(result.stdout.trim().split('\n')[0]!);
  assert.match(response.result.startupIssues[0],/not applied/);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('the tray reads cached hook status and skips token usage when it is off',async()=>{
 const root=mkdtempSync(join(tmpdir(),'ade-tray-cost-')),c=new Collector(root);
 try{
  c.updateSettings({macosActivity:false,orcaPolling:false,tokenUsage:false});
  await c.start(10);
  const internals=c as any;let usageReads=0,hookReads=0;
  const usage=internals.usageReader.summary.bind(internals.usageReader),hooks=internals.hookInstallation.status.bind(internals.hookInstallation);
  internals.usageReader.summary=()=>{usageReads++;return usage();};internals.hookInstallation.status=()=>{hookReads++;return hooks();};
  for(let i=0;i<5;i++)c.trayStatus();
  assert.equal(usageReads,0);assert.ok(hookReads<=1);
  const before=hookReads;c.hooksStatus();assert.equal(hookReads,before+1,'an explicit hook status request is always fresh');
 }finally{await c.close();rmSync(root,{recursive:true,force:true});}
});

test('hooks get a timeout that tolerates a cold start, and older installs need an update',()=>{
 const root=mkdtempSync(join(tmpdir(),'ade-hook-timeout-'));
 try{
  const manifest=prepareConfig(join(root,'settings.json'),'claude','agent-time-hook',['Stop']);
  assert.equal(hookTimeoutSeconds,10);
  assert.equal((manifest.entries.Stop as any).hooks[0].timeout,10);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('storage compaction runs off the request thread',async()=>{
 const root=mkdtempSync(join(tmpdir(),'ade-compact-worker-')),c=new Collector(root);
 try{
  c.updateSettings({macosActivity:false,orcaPolling:false,tokenUsage:false});
  c.store.transaction(()=>{for(let i=0;i<2000;i++)c.store.put({eventId:`terminal-${i}`,source:'orca',kind:'terminal',observedAt:100+i,monotonicAt:i,collectorEpoch:'epoch',hostId:'host',terminalHandle:'term',data:{title:'Same',connected:true}});});
  const pending=c.prepareStorageCompaction();
  // The request thread stays free while the copy is prepared.
  let ticks=0;const timer=setInterval(()=>{ticks++;},1);
  const report=await pending;clearInterval(timer);
  assert.ok(report.savingsBytes>0);assert.ok(existsSync(join(root,'exports',report.candidate)));
  assert.ok(ticks>0);
  assert.deepEqual(c.storageReplacementStatus()?.candidate,report.candidate);
  assert.match((await dispatchRequest({id:'again',method:'storage_compact_prepare'},c)).error as string,/already pending/);
 }finally{await c.close();rmSync(root,{recursive:true,force:true});}
});

test('archive import runs off the request thread and refreshes summaries',async()=>{
 const sourceRoot=mkdtempSync(join(tmpdir(),'ade-import-source-')),targetRoot=mkdtempSync(join(tmpdir(),'ade-import-target-'));
 const source=new EventStore(join(sourceRoot,'events.sqlite')),target=new Collector(targetRoot);
 try{
  const at=new Date('2026-10-20T10:00:00').getTime()/1000;
  source.put(sample('a',at));source.put(sample('b',at+5));
  const archive=await source.exportArchive(targetRoot),id=archive.path.split('/').at(-1)!;
  assert.equal(target.summaryForDate('2026-10-20').intervals.length,0);
  const result=await target.importArchive(id);
  assert.equal(result.addedEvents,2);
  assert.equal(target.summaryForDate('2026-10-20').intervals.filter(interval=>interval.state==='human').length,1);
 }finally{source.close();await target.close();rmSync(sourceRoot,{recursive:true,force:true});rmSync(targetRoot,{recursive:true,force:true});}
});

test('stale export copies are removed when the collector opens its folder',async()=>{
 const root=mkdtempSync(join(tmpdir(),'ade-export-tmp-'));mkdirSync(join(root,'exports'));
 const stale=join(root,'exports','agent-time-2026-10-20T10-00-00-000Z-00000000-0000-0000-0000-000000000000.sqlite.tmp');
 writeFileSync(stale,'partial');utimesSync(stale,new Date(Date.now()-2*3600_000),new Date(Date.now()-2*3600_000));
 const c=new Collector(root);
 try{assert.deepEqual(readdirSync(join(root,'exports')),[]);}finally{await c.close();rmSync(root,{recursive:true,force:true});}
});

test('concurrent Linear syncs share one refresh of the rotating token',async()=>{
 const {LinearConnection}=await import('../src/capture/linear.ts');
 const output=mkdtempSync(join(tmpdir(),'ade-linear-refresh-'));
 let secret:string|null=JSON.stringify([{accessToken:'old',refreshToken:'refresh-1',expiresAt:0,clientId:'client-id-1234',workspaceId:'w'}]),refreshes=0,keychainReads=0;
 const keychain=async(operation:'read'|'write'|'delete',value?:string)=>{if(operation==='read'){keychainReads++;await sleep(5);return secret;}secret=value||null;return null;};
 const fetcher=async(input:RequestInfo|URL,init?:RequestInit)=>{
  if(String(input).endsWith('/oauth/token')){
   refreshes++;const body=init?.body as URLSearchParams;
   if(body.get('refresh_token')!=='refresh-1')return new Response('{}',{status:400});
   await sleep(20);return new Response(JSON.stringify({access_token:'new',refresh_token:'refresh-2',expires_in:3600}),{status:200});
  }
  return new Response(JSON.stringify({data:{projects:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}}}),{status:200});
 };
 const linear=new LinearConnection(output,keychain,fetcher as typeof fetch,async()=>{});
 try{
  const results=await Promise.allSettled([linear.sync('w'),linear.sync('w'),linear.status()]);
  assert.ok(results.every(result=>result.status==='fulfilled'),JSON.stringify(results));
  assert.equal(refreshes,1);assert.equal(keychainReads,1);
  assert.match(secret||'',/refresh-2/);
 }finally{linear.close();rmSync(output,{recursive:true,force:true});}
});

test('a stuck Keychain helper is stopped after the timeout',async()=>{
 const {keychainHelper}=await import('../src/capture/linear.ts');
 const root=mkdtempSync(join(tmpdir(),'ade-keychain-')),helper=join(root,'helper');
 writeFileSync(helper,'#!/bin/sh\nexec /bin/sleep 30\n',{mode:0o755});
 try{
  const started=Date.now();
  await assert.rejects(keychainHelper(helper,200)('read'),/timed out/);
  assert.ok(Date.now()-started<5000);
 }finally{rmSync(root,{recursive:true,force:true});}
});
