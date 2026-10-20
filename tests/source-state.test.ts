import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultSettings} from '../src/capture/settings.ts';
import {sourceStates,type SourceStateInput} from '../src/capture/source-state.ts';

const input=():SourceStateInput=>({
 running:true,surfaces:{...defaultSettings},orcaAvailable:false,lastPoll:null,failedPoller:null,
 latest:{macos:null,claude:null,codex:null,orca:null},hooks:{targets:[
  {id:'claude-1',provider:'claude',label:'Claude',path:'/tmp/claude',state:'installed',lastEvent:null,error:null},
  {id:'codex-1',provider:'codex',label:'Codex',path:'/tmp/codex',state:'installed',lastEvent:null,error:null},
 ]},macosTrusted:null,macosExcluded:false,macError:false,foregroundBundleId:null,browserDetailAvailable:false,now:1000,
});
const state=(data:SourceStateInput,id:string)=>sourceStates(data).find(item=>item.id===id)!;
test('installed hooks wait for an actual event instead of claiming working capture',()=>{
 const data=input();assert.equal(state(data,'codex').state,'waiting');
 assert.equal(state(data,'codex').action,'start-session');
 data.latest.codex=900;assert.equal(state(data,'codex').state,'waiting');
 data.hooks.targets[1].lastEvent=900;assert.equal(state(data,'codex').state,'verified');
 data.hooks.targets[1].lastEvent=995;assert.equal(state(data,'codex').state,'receiving');
});
test('outdated hooks take precedence over past delivery and keep a repair action',()=>{
 const data=input();data.latest.claude=950;data.hooks.targets[0].state='needs-update';
 assert.equal(state(data,'claude').state,'repair-needed');
 assert.equal(state(data,'claude').action,'repair-hooks');
});
test('one delivered installation does not verify another installation',()=>{
 const data=input();data.hooks.targets.push({...data.hooks.targets[1],id:'codex-2',lastEvent:null});
 data.hooks.targets[1].lastEvent=995;
 assert.equal(state(data,'codex').state,'waiting');
 assert.match(state(data,'codex').detail,/1 of 2/);
});
test('paused and optional unavailable sources are distinct from failure',()=>{
 const data=input();assert.equal(state(data,'orca').state,'unavailable');
 data.running=false;assert.equal(state(data,'orca').state,'paused');
 assert.equal(state(data,'macos').action,'resume');
});
test('excluded foreground activity is intentional and does not look like a stalled helper',()=>{
 const data=input();data.macosExcluded=true;
 assert.equal(state(data,'macos').state,'excluded');
 assert.equal(state(data,'macos').action,'none');
});
test('foreground capture and optional Accessibility detail have separate states',()=>{
 const data=input();data.latest.macos=990;data.macosTrusted=false;
 assert.equal(state(data,'macos').state,'permission-limited');
 assert.equal(state(data,'macos').action,'grant-accessibility');
});
test('a macOS helper error does not falsely mark Orca polling as failed',()=>{
 const data=input();data.orcaAvailable=true;data.lastPoll=990;
 assert.equal(state(data,'orca').state,'receiving');
 data.failedPoller='orca';assert.equal(state(data,'orca').state,'failed');
});
test('a macOS helper failure is attributed to Mac activity',()=>{
 const data=input();data.latest.macos=990;data.macError=true;
 assert.equal(state(data,'macos').state,'failed');
 assert.equal(state(data,'orca').state,'unavailable');
});
test('a browser reports waiting, limited detail, and current page independently',()=>{
 const data=input();assert.equal(state(data,'safari').state,'waiting');
 data.foregroundBundleId='com.apple.Safari';data.latest.macos=990;
 assert.equal(state(data,'safari').state,'permission-limited');
 data.browserDetailAvailable=true;assert.equal(state(data,'safari').state,'receiving');
 data.latest.macos=900;assert.equal(state(data,'safari').state,'stale');
});
