import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openEventDatabase,createPackedEventSchema,insertEventRow,eventStorageStats,verifyPackedBlocks} from '../src/capture/event-database.ts';
import {packEventHistory} from '../src/capture/packed-maintenance.ts';
import {eventsDigest} from '../src/capture/compact-verification.ts';
const event=(id:string,at:number,kind:string,toolId?:string)=>JSON.stringify({eventId:id,observedAt:at,source:kind==='activity'?'macos':'hook',kind,hostId:'h',provider:'codex',sessionId:'s',data:toolId?{toolId}:{idleSeconds:0}});
test('bounded packing keeps all timing inputs, IDs, sequence, contexts and late duplicate boundaries',()=>{
 const db=openEventDatabase(':memory:');try{createPackedEventSchema(db);
 for(let i=0;i<80;i++)insertEventRow(db,String(i),i,event(String(i),i,'activity'));
 for(const [id,at,kind,tool] of [['start',90,'tool_start','t'],['end',95,'tool_end','t'],['unmatched',99,'tool_start','u'],['reverse',110,'tool_start','v'],['reversed',109,'tool_end','v']] as const)insertEventRow(db,id,at,event(id,at,kind,tool));
 const before=eventsDigest(db),order=db.prepare('SELECT rowid,event_id FROM events ORDER BY rowid').all();
 let result=packEventHistory(db,{now:1e8,maxRows:100,maxBytes:2e6});assert.ok(result.packedEvents>0);assert.equal(result.toolCalls,1);assert.equal(eventsDigest(db),before);assert.deepEqual(db.prepare('SELECT rowid,event_id FROM events ORDER BY rowid').all(),order);verifyPackedBlocks(db);
 insertEventRow(db,'late',96,event('late',96,'tool_end','t'));const late=eventsDigest(db);packEventHistory(db,{now:1e8});assert.equal(eventsDigest(db),late);assert.equal(eventStorageStats(db).hotEvents,0);
 assert.equal(packEventHistory(db,{now:1e8}).packedEvents,0);
 }finally{db.close();}
});
test('hot history stays raw until byte budget or age is reached; pass is bounded and failure rolls back',()=>{
 const db=openEventDatabase(':memory:');try{createPackedEventSchema(db);for(let i=0;i<20;i++)insertEventRow(db,String(i),9990+i,event(String(i),9990+i,'activity'));
 assert.equal(packEventHistory(db,{now:10010}).packedEvents,0);
 const before=eventsDigest(db);db.exec("CREATE TRIGGER reject_pack BEFORE UPDATE OF payload_data ON events BEGIN SELECT RAISE(ABORT,'injected'); END");assert.throws(()=>packEventHistory(db,{now:10010,hotBytes:0,maxRows:3}),/injected/);assert.equal(eventsDigest(db),before);assert.equal(eventStorageStats(db).coldEvents,0);db.exec('DROP TRIGGER reject_pack');
 const result=packEventHistory(db,{now:10010,hotBytes:0,maxRows:3});assert.ok(result.packedEvents>0&&result.packedEvents<=3);assert.equal(eventsDigest(db),before);
 }finally{db.close();}
});
test('ambiguous identities across the database never become a shared tool call',()=>{
 const db=openEventDatabase(':memory:');try{createPackedEventSchema(db);for(let i=0;i<3;i++)insertEventRow(db,String(i),i,event(String(i),i,i===0?'tool_start':'tool_end','same'));const before=eventsDigest(db);assert.equal(packEventHistory(db,{now:1e8}).toolCalls,0);assert.equal(eventsDigest(db),before);}finally{db.close();}
});
