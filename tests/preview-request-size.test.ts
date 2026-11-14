import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
test('preview accepts the supported 10,000 UUID pair assignment while retaining a finite request bound',()=>{
 const config=readFileSync(new URL('../vite.config.ts',import.meta.url),'utf8');
 const limit=Number(config.match(/body.length > (\d+)/)![1]);
 const payload=JSON.stringify({id:'test',method:'human_decision_set',params:{date:'2026-11-12',mode:'unassigned',pairs:Array.from({length:10000},()=>['a'.repeat(36),'b'.repeat(36)])}});
 assert(payload.length<limit);assert(limit<=2*1024*1024);
});
