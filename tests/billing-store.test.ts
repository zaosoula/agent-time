import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,basename} from 'node:path';
import {BillingStore,validateBillingProject} from '../src/capture/billing-store.ts';
import {EventStore} from '../src/capture/store.ts';
import {compactCaptureCopy} from '../src/capture/compact-copy.ts';
import {openEventDatabase} from '../src/capture/event-database.ts';
import type {BillingProject,BillingReport} from '../src/capture/billing-types.ts';
const project=():BillingProject=>({id:'billing-a',name:'Client A',aliases:['client'],sources:{repositories:['/repo/'],workspaceIds:['host::workspace'],reportedProjects:['contract']},timezone:'Europe/Paris',policies:[{id:'policy-1',effectiveFrom:'2026-01-01',basis:'overlapMergedWall',currency:'EUR',hourlyRate:'100.00',agentOnlyHourlyRate:null,agentWeight:'1/2',rounding:{minutes:1,mode:'nearest',scope:'period'},dailyCapMinutes:null,presenceWindowMinutes:null,aiFees:{mode:'none'}}]});
const report=(snapshot:BillingProject):BillingReport=>({reportId:'report-1',projectId:snapshot.id,projectName:snapshot.name,fromDate:'2026-01-01',toDate:'2026-01-01',timezone:snapshot.timezone,currency:'EUR',createdAt:'2026-01-02T00:00:00.000Z',calculationVersion:1,projectSnapshot:snapshot,days:[],totals:{humanActiveSeconds:0,agentWallSeconds:0,agentOnlyWallSeconds:0,agentRunningSeconds:0,overlapMergedWallSeconds:0,excludedSeconds:0,unknownSeconds:0,crossProjectOverlapSeconds:0,eligibleSeconds:0,billableSeconds:0,roundingSeconds:0,timeAmount:'0.00',aiAmount:'0.00',aiKnownAmount:'0.00',totalAmount:'0.00'},quality:{complete:true,warnings:[]},explanation:'No captured time.'});
test('legacy read-only databases return empty billing without schema writes',()=>{const db=new DatabaseSync(':memory:');db.exec('PRAGMA query_only=ON');const store=new BillingStore(db);assert.deepEqual(store.listProjects(),[]);assert.equal(store.report('missing'),null);assert.throws(()=>store.resolveProject('missing'),/unknown/i);db.close();});
test('projects survive reopening; concurrent edits require the current revision and policy history is immutable',()=>{
 const root=mkdtempSync(join(tmpdir(),'billing-')),path=join(root,'events.sqlite');let events=new EventStore(path);
 try{const store=new BillingStore(events.database),saved=store.saveProject(project());assert.equal(saved.revision,1);events.close();events=new EventStore(path);const reopened=new BillingStore(events.database);assert.deepEqual(reopened.listProjects(),[saved]);const other=new EventStore(path);try{const concurrent=new BillingStore(other.database);const edited=reopened.saveProject({...saved,name:'Updated'},1);assert.equal(edited.revision,2);assert.throws(()=>concurrent.saveProject({...saved,name:'Stale'},1),/revision/i);assert.throws(()=>reopened.saveProject({...edited,name:'No revision'}),/revision/i);assert.throws(()=>reopened.saveProject({...edited,policies:[]},2),/polic/i);assert.throws(()=>reopened.saveProject({...edited,policies:[{...edited.policies[0],hourlyRate:'200'}]},2),/immutable/i);const appended=reopened.saveProject({...edited,policies:[...edited.policies,{...edited.policies[0],id:'policy-2',effectiveFrom:'2026-02-01',hourlyRate:'120'}]},2);assert.equal(appended.policies.length,2);}finally{other.close();}}
 finally{events.close();rmSync(root,{recursive:true,force:true});}
});
test('aliases and explicit sources resolve strictly with normalized Orca worktree paths',()=>{const events=new EventStore(':memory:');try{const store=new BillingStore(events.database);store.saveProject(project());for(const alias of ['billing-a','Client A','client','contract','host::workspace','/repo/.orca/workspaces/feature/src','/repo'])assert.equal(store.resolveProject(alias).id,'billing-a');assert.throws(()=>store.resolveProject('/repository'),/unknown/i);store.saveProject({...project(),id:'billing-b',name:'Client B'});assert.throws(()=>store.resolveProject('client'),/ambiguous/i);}finally{events.close();}});
test('validation rejects unsafe quantities, dates, missing policy and unsupported mappings',()=>{
 for(const mutate of [(p:BillingProject)=>p.timezone='No/SuchZone',(p:BillingProject)=>p.policies[0].hourlyRate='1e9',(p:BillingProject)=>p.policies[0].agentWeight='1/0',(p:BillingProject)=>p.policies[0].dailyCapMinutes=1441,(p:BillingProject)=>p.policies[0].presenceWindowMinutes=0,(p:BillingProject)=>p.policies[0].effectiveFrom='2026-02-30',(p:BillingProject)=>p.sources.repositories=['/repo/*'],(p:BillingProject)=>p.policies=[]]){const p=project();mutate(p);assert.throws(()=>validateBillingProject(p));}
});
test('saved reports remain immutable snapshots across mapping and tariff edits',()=>{const events=new EventStore(':memory:');try{const store=new BillingStore(events.database),saved=store.saveProject(project()),r=report(saved);store.saveReport(r);store.saveReport(structuredClone(r));store.saveProject({...saved,name:'Other'},1);assert.equal(store.report(r.reportId)?.projectName,'Client A');assert.throws(()=>store.saveReport({...r,explanation:'Changed'}),/immutable|conflict/i);assert.deepEqual(store.report(r.reportId),r);}finally{events.close();}});
test('archive import and compaction preserve projects/reports and reject conflicting billing atomically',async()=>{
 const root=mkdtempSync(join(tmpdir(),'billing-archive-')),source=new EventStore(join(root,'events.sqlite')),target=new EventStore(join(root,'target.sqlite'));
 try{const billing=new BillingStore(source.database),p=billing.saveProject(project());billing.saveReport(report(p));const exported=await source.exportArchive(root);target.importArchive(root,basename(exported.path));const imported=new BillingStore(target.database);assert.deepEqual(imported.listProjects(),[p]);assert.deepEqual(imported.report('report-1'),report(p));assert.equal(await target.archiveFullyCovered(root,basename(exported.path)),true);source.checkpointWal();compactCaptureCopy(join(root,'events.sqlite'),join(root,'compact.sqlite'));const db=openEventDatabase(join(root,'compact.sqlite'),{readOnly:true});try{assert.deepEqual(new BillingStore(db).report('report-1'),report(p));}finally{db.close();}imported.saveProject({...p,name:'Current'},1);assert.throws(()=>target.importArchive(root,basename(exported.path)),/conflict/i);assert.equal(imported.resolveProject('billing-a').name,'Current');}
 finally{source.close();target.close();rmSync(root,{recursive:true,force:true});}
});

test('policy edits append even on the same date while history ordering remains immutable',()=>{const events=new EventStore(':memory:');try{const store=new BillingStore(events.database),p=store.saveProject(project()),next={...p.policies[0],id:'policy-2',hourlyRate:'150'};const updated=store.saveProject({...p,policies:[...p.policies,next]},1);assert.equal(updated.policies[1].effectiveFrom,p.policies[0].effectiveFrom);assert.throws(()=>store.saveProject({...updated,policies:[next,p.policies[0]]},2),/immutable/i);}finally{events.close();}});
test('archive billing conflicts and corrupt policy history never import partial evidence',async()=>{
 const root=mkdtempSync(join(tmpdir(),'billing-corrupt-')),source=new EventStore(join(root,'source.sqlite')),target=new EventStore(join(root,'target.sqlite'));
 try{const p=new BillingStore(source.database).saveProject(project());source.put({eventId:'archive-only',source:'test',kind:'running',observedAt:10,monotonicAt:1,collectorEpoch:'a'});const archive=await source.exportArchive(root),id=basename(archive.path),db=openEventDatabase(archive.path);try{db.prepare('DELETE FROM billing_policies WHERE project_id=?').run(p.id);}finally{db.close();}assert.throws(()=>target.importArchive(root,id),/policy history/i);assert.equal(target.count(),0);assert.deepEqual(new BillingStore(target.database).listProjects(),[]);}finally{source.close();target.close();rmSync(root,{recursive:true,force:true});}
});
test('saved reports reject invalid financial values instead of silently serializing them',()=>{const events=new EventStore(':memory:');try{const store=new BillingStore(events.database),p=store.saveProject(project());for(const mutate of [(r:BillingReport)=>r.totals.humanActiveSeconds=NaN,(r:BillingReport)=>r.totals.timeAmount='1e6',(r:BillingReport)=>r.currency='EURO']){const r=report(p);mutate(r);assert.throws(()=>store.saveReport(r),/billing/i);assert.equal(store.report(r.reportId),null);}}finally{events.close();}});
test('optional undefined snapshot revisions use valid JSON and key order does not change report identity',()=>{const events=new EventStore(':memory:');try{const store=new BillingStore(events.database),snapshot={...project(),revision:undefined},r=report(snapshot);store.saveReport(r);assert.equal(store.report(r.reportId)?.projectSnapshot.id,snapshot.id);store.saveReport({...r,projectSnapshot:{policies:snapshot.policies,timezone:snapshot.timezone,sources:snapshot.sources,aliases:snapshot.aliases,name:snapshot.name,id:snapshot.id}});}finally{events.close();}});
test('repository roots cover descendants with boundary and longest-root ownership',()=>{const events=new EventStore(':memory:');try{const store=new BillingStore(events.database);store.saveProject(project());assert.equal(store.resolveProject('/repo/src').id,'billing-a');assert.equal(store.resolveProject('/repo/.orca/workspaces/feature/src').id,'billing-a');assert.throws(()=>store.resolveProject('/repo2/src'),/unknown/i);store.saveProject({...project(),id:'nested',name:'Nested',aliases:[],sources:{repositories:['/repo/packages/nested'],workspaceIds:[],reportedProjects:[]}});assert.equal(store.resolveProject('/repo/packages/nested/src').id,'nested');assert.equal(store.resolveProject('/repo/packages/nested-other').id,'billing-a');store.saveProject({...project(),id:'duplicate',name:'Duplicate',aliases:[],sources:{repositories:['/repo/packages/nested'],workspaceIds:[],reportedProjects:[]}});assert.throws(()=>store.resolveProject('/repo/packages/nested/src'),/ambiguous/i);}finally{events.close();}});
test('configuration validation applies the app transport payload limit',()=>{const p=project();p.sources.workspaceIds=Array.from({length:100},(_,i)=>String(i)+'x'.repeat(3000));assert.throws(()=>validateBillingProject(p),/large|size|limit/i);});

test('workspace IDs carrying a repository path resolve without registering every worktree ID',()=>{const events=new EventStore(':memory:');try{const store=new BillingStore(events.database),p=store.saveProject(project());assert.equal(store.resolveProject('orca::'+p.sources.repositories[0]+'/.orca/workspaces/one').id,p.id);}finally{events.close();}});

test('counting modes validate without materializing legacy defaults',()=>{
 const legacy=project();assert.equal(Object.hasOwn(validateBillingProject(legacy).policies[0]!,'countingMode'),false);
 for(const countingMode of ['minutes','seconds'] as const){const value=project();value.policies[0]!.countingMode=countingMode;assert.equal(validateBillingProject(value).policies[0]!.countingMode,countingMode);}
 for(const countingMode of ['hours','',null,1,['minutes'],{toString:()=> 'minutes'}]){const value=project();Object.assign(value.policies[0]!,{countingMode});assert.throws(()=>validateBillingProject(value),/counting/i);}
});
test('new policy saves default to minutes while raw legacy policy prefixes remain untouched',()=>{
 const events=new EventStore(':memory:');try{
  const store=new BillingStore(events.database),legacy=validateBillingProject({...project(),revision:1});
  const canonical=(value:unknown):string=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical((value as Record<string,unknown>)[key])).join(',')+'}':JSON.stringify(value);
  const originalPolicy=canonical(legacy.policies[0]);
  events.database.prepare('INSERT INTO billing_projects VALUES(?,?,?)').run(legacy.id,1,canonical(legacy));
  events.database.prepare('INSERT INTO billing_policies VALUES(?,?,?)').run(legacy.id,legacy.policies[0]!.id,originalPolicy);
  const renamed=store.saveProject({...store.listProjects()[0]!,name:'Renamed'},1);
  assert.equal(Object.hasOwn(renamed.policies[0]!,'countingMode'),false);
  const appended=store.saveProject({...renamed,policies:[...renamed.policies,{...renamed.policies[0]!,id:'new-policy'}]},2);
  assert.equal(appended.policies[1]!.countingMode,'minutes');assert.equal(Object.hasOwn(appended.policies[0]!,'countingMode'),false);
  assert.equal(events.database.prepare('SELECT payload FROM billing_policies WHERE id=?').get(legacy.policies[0]!.id)?.payload,originalPolicy);
  assert.equal(store.saveProject({...project(),id:'brand-new'}).policies[0]!.countingMode,'minutes');
 }finally{events.close();}
});
test('archives preserve legacy counting omissions and immutable report bytes',async()=>{
 const root=mkdtempSync(join(tmpdir(),'billing-legacy-counting-')),source=new EventStore(join(root,'source.sqlite')),target=new EventStore(join(root,'target.sqlite'));
 try{
  const legacy=validateBillingProject({...project(),revision:1}),store=new BillingStore(source.database),saved=report(legacy);
  // Seed actual pre-feature rows rather than passing through new-policy defaults.
  store.saveReport(saved);
  const canonical=(value:unknown):string=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical((value as Record<string,unknown>)[key])).join(',')+'}':JSON.stringify(value);
  source.database.prepare('INSERT INTO billing_projects VALUES(?,?,?)').run(legacy.id,1,canonical(legacy));
  source.database.prepare('INSERT INTO billing_policies VALUES(?,?,?)').run(legacy.id,legacy.policies[0]!.id,canonical(legacy.policies[0]));
  const original=source.database.prepare('SELECT payload FROM billing_reports WHERE id=?').get(saved.reportId)?.payload;
  const archive=await source.exportArchive(root);target.importArchive(root,basename(archive.path));
  const imported=new BillingStore(target.database);assert.deepEqual(imported.listProjects(),[legacy]);imported.saveReport(saved);
  assert.equal(target.database.prepare('SELECT payload FROM billing_reports WHERE id=?').get(saved.reportId)?.payload,original);
 }finally{source.close();target.close();rmSync(root,{recursive:true,force:true});}
});

test('optional report counting disclosures validate without accepting malformed values',()=>{
 const events=new EventStore(':memory:');try{
  const store=new BillingStore(events.database),p=project();p.policies[0]!.countingMode='seconds';
  assert.equal(store.saveProject(p).policies[0]!.countingMode,'seconds');
  const valid=report(p);valid.countingModes=['minutes','seconds'];valid.totals.rawEligibleSeconds=0;valid.totals.countingAdjustmentSeconds=0;store.saveReport(valid);
  for(const field of ['rawEligibleSeconds','countingAdjustmentSeconds'] as const)for(const value of [-1,NaN,'0']){
   const invalid=report(p);invalid.reportId=randomId();Object.assign(invalid.totals,{[field]:value});assert.throws(()=>store.saveReport(invalid),/counting/i);
  }
  const invalid=report(p);invalid.reportId=randomId();Object.assign(invalid,{countingModes:['hours']});assert.throws(()=>store.saveReport(invalid),/counting/i);
 }finally{events.close();}
 function randomId(){return `invalid-${Math.random()}`;}
});
