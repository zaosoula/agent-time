import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {encodeEventBlock,decodeEventBlock,MAX_BLOCK_EVENTS,MAX_BLOCK_BYTES} from '../src/capture/packed-codec.ts';
const event=(id:string,kind:string,at:number,extra:Record<string,unknown>={})=>JSON.stringify({eventId:id,source:'hook',kind,observedAt:at,monotonicAt:at,collectorEpoch:'epoch',hostId:'local',provider:'claude',sessionId:'session',data:{toolId:'tool',toolName:'Read',stopBlocked:false},...extra});

test('packed blocks preserve exact raw strings, Unicode, unusual keys and noncanonical JSON',()=>{
 const values=[event('a','tool_start',1),'{ "z": 1, "a": "é/📘" }','null','[1,false,null]',JSON.stringify(JSON.parse('{"__proto__":{"value":1},"data":{"constructor":false}}'))];
 const block=encodeEventBlock(values);
 assert.deepEqual(decodeEventBlock(block.data,block.key),values);
 assert.equal(block.count,5);assert.equal(block.originalBytes,values.reduce((n,s)=>n+Buffer.byteLength(s),0));
});

test('one completed tool-call record preserves both boundary IDs, field order and differing context',()=>{
 const values=[event('start','tool_start',100,{collectorEpoch:'first',cwd:'/before'}),event('other','waiting',105,{data:{toolId:'other'}}),event('end','tool_end',110,{collectorEpoch:'second',cwd:'/after',data:{toolName:'Read',toolId:'tool',hook:'PostToolUseFailure',stopBlocked:true}})];
 const block=encodeEventBlock(values,[[0,2]]);
 assert.equal(block.records.toolCalls,1);
 assert.deepEqual(decodeEventBlock(block.data,block.key),values);
});

test('ambiguous, unmatched, noncanonical and clock-reversed tool boundaries stay ordinary evidence',()=>{
 const a=event('a','tool_start',100),b=event('b','tool_end',110),duplicate=event('c','tool_start',101);
 for(const [values,pairs] of [[[a,duplicate,b],[[0,2]]],[[a],[]],[[a,b.replaceAll(',',', ')],[[0,1]]],[[event('s','tool_start',120),b],[[0,1]]]] as Array<[string[],Array<[number,number]>]>){
  const block=encodeEventBlock(values,pairs);assert.equal(block.records.toolCalls,0);assert.deepEqual(decodeEventBlock(block.data,block.key),values);
 }
});

test('activity contexts share storage while preserving idle values, permission changes and intervening fences',()=>{
 const sample=(id:string,at:number,idle:number,trusted=true)=>event(id,'activity',at,{source:'macos',data:{foregroundBundleId:'editor',foregroundName:'Editor',idleSeconds:idle,accessibilityTrusted:trusted}});
 const values=[sample('a',100,0),event('fence','capture_stop',101,{source:'capture'}),sample('b',102,1),sample('c',104,2),sample('permission',106,4,false),sample('gap',200,90,false)];
 const block=encodeEventBlock(values);assert.equal(block.records.activityRuns,1);assert.deepEqual(decodeEventBlock(block.data,block.key),values);
});

test('non-fresh worker observations share context and retain every epoch and heartbeat point',()=>{
 const sample=(id:string,at:number,epoch:string)=>event(id,'worker',at,{source:'orca',collectorEpoch:epoch,dispatchId:'dispatch',data:{fresh:false,state:'unknown',outcome:'in_progress'}});
 const values=[sample('first',100,'a'),sample('beat',400,'b'),event('fresh','worker',401,{source:'orca',data:{fresh:true}}),sample('last',900,'b')];
 const block=encodeEventBlock(values);assert.equal(block.records.workerRuns,1);assert.deepEqual(decodeEventBlock(block.data,block.key),values);
});

test('block sizes and decoded expansion are bounded and corruption is rejected',()=>{
 assert.throws(()=>encodeEventBlock([]),/block|count/i);
 assert.throws(()=>encodeEventBlock(Array.from({length:MAX_BLOCK_EVENTS+1},()=>'{"a":1}')),/block|count/i);
 assert.throws(()=>encodeEventBlock(['x'.repeat(MAX_BLOCK_BYTES+1)]),/block|size|bytes/i);
 const block=encodeEventBlock(['{"a":1}']);const broken=Buffer.from(block.data);broken[broken.length-1]^=1;
 assert.throws(()=>decodeEventBlock(broken,block.key),/hash|digest|corrupt/i);
 assert.throws(()=>decodeEventBlock(block.data.subarray(0,10),block.key),/hash|digest|corrupt/i);
 const bomb=gzipSync(Buffer.alloc(5*1024*1024,65)),key=createHash('sha256').update(bomb).digest('hex');
 assert.throws(()=>decodeEventBlock(bomb,key),/limit|size|length|large|corrupt/i);
 const invalid=gzipSync(JSON.stringify({version:99})),invalidKey=createHash('sha256').update(invalid).digest('hex');
 assert.throws(()=>decodeEventBlock(invalid,invalidKey),/version|format|corrupt/i);
});

test('shared records substantially reduce repetitive payload bytes before any history is discarded',()=>{
 const values=Array.from({length:500},(_,i)=>event('id-'+i,'activity',100+i*2,{source:'macos',data:{foregroundBundleId:'com.example.Editor',foregroundName:'Editor',idleSeconds:i%10,accessibilityTrusted:true}}));
 const block=encodeEventBlock(values);assert.ok(block.data.length<block.originalBytes/5);assert.deepEqual(decodeEventBlock(block.data,block.key),values);
});
