import {test} from 'node:test';import assert from 'node:assert/strict';
import {storageProjection} from '../src/ui/storage-presentation.ts';
test('growth estimate uses measured compression and preserves event counts separately',()=>{
 const byDay=[{date:'2026-11-01',source:'macos',events:100,payloadBytes:1000},{date:'2026-11-01',source:'hook',events:20,payloadBytes:500},{date:'2026-11-02',source:'hook',events:100,payloadBytes:500}];
 assert.deepEqual(storageProjection(byDay,{efficient:true,originalBytes:10000,compressedBytes:1000}),{bytes:3000,compressed:true});assert.deepEqual(storageProjection(byDay),{bytes:30000,compressed:false});assert.deepEqual(storageProjection([]),{bytes:null,compressed:false});
});
