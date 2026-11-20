import{test}from'node:test';import assert from'node:assert/strict';import{mkdtempSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';import{EventStore}from'../src/capture/store.ts';import{makeEvent}from'../src/capture/events.ts';import{IngestionModel,type PreparedCreditedInput}from'../src/capture/ingestion-model.ts';
const prepared=(date='2026-10-20'):PreparedCreditedInput=>{const start=Date.parse(date+'T00:00:00Z')/1000,end=start+86400;return{value:{date,start,end,spans:[{start:start+100,end:start+110,kind:'human',sessionKey:'h',projectId:'p'},{start:start+110,end:start+120,kind:'human',sessionKey:'h',projectId:'p'}],excluded:[],humanMessages:[],presenceEvidenceAvailable:false,usage:[],usageComplete:false,coverageComplete:false},paths:[],sessions:[['claude','session']],tasks:['task'],asOf:end+100,validUntil:Infinity};};
const fixture=()=>{const root=mkdtempSync(join(tmpdir(),'at-ingest-model-'));return{root,store:new EventStore(join(root,'events.sqlite')),model:new IngestionModel(root)};};
test('ingestion persists typed credited periods independently from display cache, targets ordinary appends and late contexts',()=>{const{root,store,model}=fixture();try{
 store.put(makeEvent('macos','activity',{eventId:'a',observedAt:Date.parse('2026-10-20T12:00:00Z')/1000}));while(!model.sync(store.database).caughtUp){}const value=prepared();assert(model.put(store.database,'p','2026-10-20','config',value));
 const first=model.get(store.database,'p','2026-10-20','config',value.asOf);assert.equal(first?.spans.length,1);assert.deepEqual(first?.spans[0],{...value.value.spans[0],end:value.value.spans[1]!.end});
 store.put(makeEvent('macos','activity',{eventId:'unrelated',observedAt:Date.parse('2026-11-10T12:00:00Z')/1000}));assert(model.get(store.database,'p','2026-10-20','config',value.asOf));assert.equal(model.stats().dirty,0);
 store.put(makeEvent('agent_report','work_context',{eventId:'old-context',provider:'claude',sessionId:'session',observedAt:Date.parse('2026-10-01T12:00:00Z')/1000}));assert.equal(model.get(store.database,'p','2026-10-20','config',value.asOf),undefined);assert.equal(model.stats().dirty,1);
 }finally{model.close();store.close();rmSync(root,{recursive:true,force:true});}});
test('late tool boundaries and review corrections dirty their affected windows and preserve all source evidence',()=>{const{root,store,model}=fixture();try{const at=Date.parse('2026-10-20T23:59:00Z')/1000;store.put(makeEvent('hook','tool_start',{eventId:'start',provider:'claude',hostId:'local',sessionId:'session',observedAt:at,data:{toolId:'t'}}));while(!model.sync(store.database).caughtUp){}for(const date of ['2026-10-20','2026-10-21'])assert(model.put(store.database,'p',date,'config',prepared(date)));const before=store.events();store.put(makeEvent('hook','tool_end',{eventId:'end',provider:'claude',hostId:'local',sessionId:'session',observedAt:at+120,data:{toolId:'t'}}));model.sync(store.database);assert.equal(model.stats().dirty,2);assert.deepEqual(store.events().slice(0,1),before);
 for(const date of ['2026-10-20','2026-10-21'])assert(model.put(store.database,'p',date,'config',prepared(date)));store.setHumanDecisions([['start','end']],'assigned','/project');model.sync(store.database);assert.equal(model.stats().dirty,2);
 }finally{model.close();store.close();rmSync(root,{recursive:true,force:true});}});
test('ingestion marks overlapping credited slices dirty on a range change',()=>{const{root,store,model}=fixture();try{model.sync(store.database);for(const date of ['2026-10-20','2026-10-21'])assert(model.put(store.database,'p',date,'config',prepared(date)));assert.equal(model.stats().dirty,0);
 const at=Date.parse('2026-10-20T12:00:00Z')/1000,saved=store.addAgentTimeExclusion({executionKey:'local::claude::session',date:'2026-10-20',start:at,end:at+600});model.sync(store.database);assert.equal(model.stats().dirty,1);
 assert(model.put(store.database,'p','2026-10-20','config',prepared('2026-10-20')));store.undoAgentTimeExclusion(saved.id,'2026-10-20');model.sync(store.database);assert.equal(model.stats().dirty,1);
 }finally{model.close();store.close();rmSync(root,{recursive:true,force:true});}});
test('pinned older snapshots cannot read newer materialization and corrupted periods fall back',()=>{const{root,store,model}=fixture();try{model.sync(store.database);const value=prepared();model.put(store.database,'p',value.value.date,'config',value);const first=model.get(store.database,'p',value.value.date,'config',value.asOf);assert(first);assert.equal(model.get(store.database,'p',value.value.date,'changed',value.asOf),undefined);model.database.prepare('UPDATE credited_periods SET end=end+1').run();assert.equal(model.get(store.database,'p',value.value.date,'config',value.asOf),undefined);
 }finally{model.close();store.close();rmSync(root,{recursive:true,force:true});}});

import{openEventDatabase}from'../src/capture/event-database.ts';
test('older pinned readers never consume or reset a newer ingestion snapshot',()=>{const{root,store,model}=fixture();const pinned=openEventDatabase(join(root,'events.sqlite'),{readOnly:true});try{
 model.sync(store.database);const value=prepared();model.put(store.database,'p',value.value.date,'config',value);pinned.exec('BEGIN');pinned.prepare('SELECT count(*) n FROM events').get();
 store.put(makeEvent('macos','activity',{observedAt:value.value.start+100}));model.sync(store.database);model.put(store.database,'p',value.value.date,'config',value);const cursor=model.stats().cursor;
 assert.equal(model.get(pinned,'p',value.value.date,'config',value.asOf),undefined);assert.equal(model.stats().cursor,cursor);assert(model.get(store.database,'p',value.value.date,'config',value.asOf));
 }finally{pinned.close();model.close();store.close();rmSync(root,{recursive:true,force:true});}});

test('resource and session changes outside timing windows target only their actual dependencies',()=>{const{root,store,model}=fixture();try{
 model.sync(store.database);const value=prepared();value.urls=['https://example.test/a'];model.put(store.database,'p',value.value.date,'config',value);
 store.put(makeEvent('agent_report','resource',{eventId:'other-url',observedAt:Date.parse('2026-11-05T12:00:00Z')/1000,data:{url:'https://example.test/other'}}));model.sync(store.database);assert.equal(model.stats().dirty,0);
 store.put(makeEvent('agent_report','work_context',{eventId:'future-context',observedAt:Date.parse('2026-11-05T12:00:00Z')/1000,provider:'claude',sessionId:'session',data:{project:'/other'}}));model.sync(store.database);assert.equal(model.stats().dirty,0);
 store.put(makeEvent('agent_report','resource',{eventId:'matching-url',observedAt:Date.parse('2026-11-05T12:00:00Z')/1000,data:{url:'https://example.test/a?changed=1'}}));model.sync(store.database);assert.equal(model.stats().dirty,1);
 }finally{model.close();store.close();rmSync(root,{recursive:true,force:true});}});

test('deleting the newest source row invalidates affected periods and ingestion resumes',()=>{const{root,store,model}=fixture();try{
 const value=prepared();store.put(makeEvent('macos','activity',{eventId:'keep',observedAt:value.value.start+100}));store.put(makeEvent('macos','activity',{eventId:'delete',observedAt:value.value.start+110}));model.sync(store.database);model.put(store.database,'p',value.value.date,'config',value);
 store.database.prepare('DELETE FROM events WHERE event_id=?').run('delete');assert.equal(model.sync(store.database).caughtUp,true);assert.equal(model.stats().dirty,1);model.put(store.database,'p',value.value.date,'config',value);
 store.put(makeEvent('macos','activity',{eventId:'replacement',observedAt:value.value.start+120}));assert.equal(model.sync(store.database).caughtUp,true);assert.equal(model.stats().dirty,1);
 }finally{model.close();store.close();rmSync(root,{recursive:true,force:true});}});

test('optional tool index exhaustion does not stop persistent credit preparation',()=>{const{root,store,model}=fixture();try{
 (model.tools as unknown as {maxBytes:number}).maxBytes=0;store.put(makeEvent('hook','tool_start',{eventId:'full',provider:'claude',sessionId:'session',hostId:'local',observedAt:10,data:{toolId:'t'}}));assert.equal(model.sync(store.database).caughtUp,true);assert.equal(model.stats().toolIndexAvailable,false);const value=prepared();assert(model.put(store.database,'p',value.value.date,'config',value));assert(model.get(store.database,'p',value.value.date,'config',value.asOf));assert.equal(store.count(),1);
 }finally{model.close();store.close();rmSync(root,{recursive:true,force:true});}});

test('physical source timestamp corrections dirty both affected windows even with unchanged payload',()=>{const{root,store,model}=fixture();try{
 const old=prepared(),next=prepared('2026-11-10'),middle=prepared('2026-10-29');store.put(makeEvent('macos','activity',{eventId:'move',observedAt:old.value.start+100}));model.sync(store.database);for(const value of [old,next,middle])model.put(store.database,'p',value.value.date,'config',value);
 store.database.prepare('UPDATE events SET observed_at=? WHERE event_id=?').run(next.value.start+100,'move');assert(model.sync(store.database).caughtUp);assert.deepEqual(model.database.prepare('SELECT date FROM credited_slices WHERE dirty=1 ORDER BY date').all().map(r=>r.date),[old.value.date,next.value.date]);
 }finally{model.close();store.close();rmSync(root,{recursive:true,force:true});}});

test('historical preparation counts use closed periods of active projects and exclude live work',()=>{const{root,store,model}=fixture();try{
 model.sync(store.database);for(const date of ['2026-10-20','2026-10-21','2026-10-22'])model.put(store.database,'p',date,'config',prepared(date));model.put(store.database,'deleted-project','2026-10-20','config',prepared());model.database.prepare("UPDATE credited_slices SET dirty=1 WHERE project='p' AND date='2026-10-20'").run();
 assert.deepEqual(model.historyStats(Date.parse('2026-10-22T12:00:00Z')/1000,['p']),{projects:1,total:2,prepared:1,pending:1});assert.deepEqual(model.historyStats(Date.parse('2026-10-22T12:00:00Z')/1000,[]),{projects:0,total:0,prepared:0,pending:0});
 }finally{model.close();store.close();rmSync(root,{recursive:true,force:true});}});

test('journal replay discovers relocated and reused-rowid history dates',()=>{const{root,store,model}=fixture();try{
 const at=(date:string)=>Date.parse(date+'T12:00Z')/1000,first=makeEvent('hook','tool_start',{eventId:'move',provider:'claude',hostId:'local',sessionId:'s',observedAt:at('2026-01-01'),data:{toolId:'t'}});store.put(first);model.sync(store.database);
 const relocated={...first,observedAt:at('2026-10-01')};store.database.prepare('UPDATE events SET observed_at=?,payload_data=? WHERE event_id=?').run(relocated.observedAt,JSON.stringify(relocated),first.eventId);assert(model.sync(store.database).caughtUp);assert(model.buckets().includes(Math.floor(relocated.observedAt/86400)));
 store.database.prepare('DELETE FROM events').run();store.put({...first,eventId:'reused',observedAt:at('2026-11-01')});assert(model.sync(store.database).caughtUp);assert(model.buckets().includes(Math.floor(at('2026-11-01')/86400)));
 }finally{model.close();store.close();rmSync(root,{recursive:true,force:true});}});
test('initial and rebuilt ingestion includes negative and zero rowids without changing source order',()=>{const{root,store,model}=fixture();try{
 for(const[rowid,date]of[[-2,'2026-01-01'],[0,'2026-02-01'],[1,'2026-03-01']]as const){const e=makeEvent('hook','tool_start',{eventId:'id'+rowid,provider:'claude',hostId:'local',sessionId:'s'+rowid,observedAt:Date.parse(date+'T12:00Z')/1000,data:{toolId:'t'}});store.database.prepare('INSERT INTO events(rowid,event_id,observed_at,payload_data) VALUES(?,?,?,?)').run(rowid,e.eventId,e.observedAt,JSON.stringify(e));}
 const proof=store.events();while(!model.sync(store.database,1).caughtUp){}assert.equal(model.stats().tools,3);assert.equal(model.buckets().length,3);model.discard();while(!model.sync(store.database,1).caughtUp){}assert.equal(model.stats().tools,3);assert.deepEqual(store.events(),proof);
 }finally{model.close();store.close();rmSync(root,{recursive:true,force:true});}});

test('v2 ingestion models rebuild safely to discover zero-rowid evidence',()=>{
 const root=mkdtempSync(join(tmpdir(),'at-ingestion-v2-')),store=new EventStore(join(root,'events.sqlite'));let model=new IngestionModel(root);try{
 const e=makeEvent('hook','tool_start',{eventId:'zero',provider:'claude',hostId:'local',sessionId:'s',observedAt:100,data:{toolId:'t'}});store.database.prepare('INSERT INTO events(rowid,event_id,observed_at,payload_data) VALUES(0,?,?,?)').run(e.eventId,e.observedAt,JSON.stringify(e));model.sync(store.database);model.database.exec('ALTER TABLE ingestion_state DROP COLUMN started;PRAGMA user_version=2');model.close();model=new IngestionModel(root);assert(model.sync(store.database).caughtUp);assert.equal(model.stats().tools,1);assert.deepEqual(store.events().map(e=>e.eventId),['zero']);
 }finally{model.close();store.close();rmSync(root,{recursive:true,force:true});}
});
test('all-negative histories and their deletion can reach a caught-up empty source',()=>{const{root,store,model}=fixture();try{
 const e=makeEvent('hook','tool_start',{eventId:'negative',provider:'claude',hostId:'local',sessionId:'s',observedAt:100,data:{toolId:'t'}});store.database.prepare('INSERT INTO events(rowid,event_id,observed_at,payload_data) VALUES(-2,?,?,?)').run(e.eventId,e.observedAt,JSON.stringify(e));assert(model.sync(store.database).caughtUp);assert.equal(model.stats().tools,1);store.database.exec('DELETE FROM events');assert(model.sync(store.database).caughtUp);assert.equal(model.stats().tools,0);
 }finally{model.close();store.close();rmSync(root,{recursive:true,force:true});}});
