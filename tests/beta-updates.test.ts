import {test} from 'node:test';
import assert from 'node:assert/strict';
import {installBetaUpdate} from '../src/ui/beta-updates.ts';
test('an update stops capture only after a complete download, then restarts after install',async()=>{
 const calls:string[]=[];
 await installBetaUpdate({download:async()=>{calls.push('download');},install:async()=>{calls.push('install');}},async()=>{calls.push('prepare');},async()=>{calls.push('relaunch');});
 assert.deepEqual(calls,['download','prepare','install','relaunch']);
});
test('a failed download keeps the collector running',async()=>{
 const calls:string[]=[];
 await assert.rejects(installBetaUpdate({download:async()=>{throw Error('offline');},install:async()=>{calls.push('install');}},async()=>{calls.push('prepare');},async()=>{calls.push('relaunch');}),/offline/);
 assert.deepEqual(calls,[]);
});
test('a failed install relaunches the app so capture resumes',async()=>{
 const calls:string[]=[];
 await assert.rejects(installBetaUpdate({download:async()=>{},install:async()=>{throw Error('bad signature');}},async()=>{calls.push('prepare');},async()=>{calls.push('relaunch');}),/bad signature/);
 assert.deepEqual(calls,['prepare','relaunch']);
});
test('an interrupted download never stops capture',async()=>{
 const calls:string[]=[];
 await assert.rejects(installBetaUpdate({download:async()=>{throw new DOMException('Interrupted','AbortError');},install:async()=>{calls.push('install');}},async()=>{calls.push('prepare');},async()=>{calls.push('relaunch');}),/Interrupted/);
 assert.deepEqual(calls,[]);
});
test('a failed preparation relaunches the app because capture may already be stopped',async()=>{
 const calls:string[]=[];
 await assert.rejects(installBetaUpdate({download:async()=>{calls.push('download');},install:async()=>{calls.push('install');}},async()=>{calls.push('prepare');throw Error('collector flush failed');},async()=>{calls.push('relaunch');}),/collector flush failed/);
 assert.deepEqual(calls,['download','prepare','relaunch']);
});
test('a failed relaunch resumes the collector in the still-open app',async()=>{
 const calls:string[]=[];
 await assert.rejects(installBetaUpdate({download:async()=>{calls.push('download');},install:async()=>{calls.push('install');}},async()=>{calls.push('prepare');},async()=>{calls.push('relaunch');throw Error('relaunch denied');},undefined,async()=>{calls.push('recover');}),/relaunch denied/);
 assert.deepEqual(calls,['download','prepare','install','relaunch','recover']);
});
