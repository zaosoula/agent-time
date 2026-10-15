import {test} from 'node:test';
import assert from 'node:assert/strict';
import {outdatedHookTargets} from '../src/ui/hook-warning.ts';
import type {CaptureStatus} from '../src/ui/transport.ts';
import type {HookInstallationStatus} from '../src/capture/hook-installation.ts';

const capture=(running=true,claudeHooks=true)=>({running,surfaces:{claudeHooks,codexHooks:true}} as CaptureStatus);
const installation=()=>({
 agents:[{id:'claude',name:'Claude Code',setting:'claudeHooks',usageSetting:'claudeTokenUsage'},{id:'codex',name:'Codex',setting:'codexHooks',usageSetting:'codexTokenUsage'}],
 targets:[
  {id:'old',provider:'claude',label:'Claude Code · user',path:'/tmp/claude',state:'needs-update',lastEvent:null,error:null},
  {id:'new',provider:'codex',label:'Codex · user',path:'/tmp/codex',state:'installed',lastEvent:null,error:null},
 ]
} as HookInstallationStatus);

test('outdated enabled hooks warn while capture runs, then clear after repair',()=>{
 const hooks=installation();
 assert.deepEqual(outdatedHookTargets(capture(),hooks).map(target=>target.id),['old']);
 hooks.targets[0].state='installed';
 assert.deepEqual(outdatedHookTargets(capture(),hooks),[]);
});

test('paused capture and disabled agent hooks do not report idle tracking',()=>{
 const hooks=installation();
 assert.deepEqual(outdatedHookTargets(capture(false),hooks),[]);
 assert.deepEqual(outdatedHookTargets(capture(true,false),hooks),[]);
 assert.deepEqual(outdatedHookTargets(null,hooks),[]);
});
