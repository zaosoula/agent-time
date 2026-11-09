import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadSources} from '../src/capture/sources/registry.ts';
import {settingsForSources,validateSettings} from '../src/capture/settings.ts';
import {browserProbeArguments} from '../src/capture/browser-probe.ts';

test('a browser added as one source file is discovered, configurable, and passed to the generic probe',async()=>{
 const folder=mkdtempSync(join(tmpdir(),'agent-time-sources-'));
 try{
  writeFileSync(join(folder,'example.browser.ts'),`export default {kind:'browser',id:'example',name:'Example',detail:'Example Browser',bundleId:'org.example.Browser',setting:'browserExample',defaultEnabled:true,titleSuffix:' - Example'};\n`);
  const sources=await loadSources(folder),defaults=settingsForSources(sources);
  assert.equal(sources.length,1);assert.equal(defaults.browserExample,true);
  assert.deepEqual(validateSettings({browserExample:false},defaults),{browserExample:false});
  assert.deepEqual(browserProbeArguments(sources.filter(source=>source.kind==='browser'),defaults),['--browser-bundle=org.example.Browser','--browser-suffix=org.example.Browser| - Example']);
  assert.throws(()=>validateSettings({browserOther:true},defaults));
 }finally{rmSync(folder,{recursive:true,force:true});}
});

test('an agent added as one source file supplies hook and usage capabilities',async()=>{
 const folder=mkdtempSync(join(tmpdir(),'agent-time-sources-'));
 try{
  writeFileSync(join(folder,'example.agent.ts'),`export default {kind:'agent',id:'example',name:'Example Agent',setting:'exampleHooks',usageSetting:'exampleTokenUsage',defaultEnabled:true,configDirectory:'.example',configFile:'settings.json',configEnv:'EXAMPLE_HOME',discoverAccount:()=>[],hookEvents:['Stop'],normalizeHook:()=>({provider:'example'}),parseUsage:()=>undefined,defaultUsagePath:'.example/sessions',usagePaths:['home/sessions'],dedupe:'first',childSessionIds:false};\n`);
  const sources=await loadSources(folder),defaults=settingsForSources(sources);
  assert.equal(sources.length,1);assert.equal(defaults.exampleHooks,true);assert.equal(defaults.exampleTokenUsage,true);
  assert.deepEqual(validateSettings({exampleHooks:false,exampleTokenUsage:false},defaults),{exampleHooks:false,exampleTokenUsage:false});
  assert.equal(sources[0].kind,'agent');
 }finally{rmSync(folder,{recursive:true,force:true});}
});
test('Claude hooks keep background shell IDs and status but no command or prompt text',async()=>{
 const {normalizeHook}=await import('../src/capture/hooks.ts');
 const launched=normalizeHook('claude',{hook_event_name:'PostToolUse',session_id:'s',tool_use_id:'u',tool_name:'Bash',tool_input:{command:'sleep 25',run_in_background:true},tool_response:{stdout:'',backgroundTaskId:'bbt0tfoga'}},{});
 assert.equal(launched.data?.backgroundTaskId,'bbt0tfoga');
 const stop=normalizeHook('claude',{hook_event_name:'Stop',session_id:'s',background_tasks:[{id:'bbt0tfoga',type:'shell',status:'running',command:'sleep 25'},{id:'x',type:'local_agent',status:'running'},{id:'y',type:'shell',status:'completed'}]},{});
 assert.deepEqual(stop.data?.backgroundTasks,['bbt0tfoga']);
 const done=normalizeHook('claude',{hook_event_name:'UserPromptSubmit',session_id:'s',prompt:'<task-notification>\n<task-id>bbt0tfoga</task-id>\n<status>completed</status>\n<summary>secret summary</summary>\n</task-notification>'},{});
 assert.equal(done.kind,'prompt_submitted');assert.deepEqual([done.data?.backgroundTaskId,done.data?.backgroundStatus],['bbt0tfoga','completed']);
 assert.ok(!JSON.stringify([launched,stop,done]).includes('sleep 25')&&!JSON.stringify(done).includes('secret'));
 const typed=normalizeHook('claude',{hook_event_name:'UserPromptSubmit',session_id:'s',prompt:'please explain <task-id>z</task-id>'},{});
 assert.equal(typed.data?.backgroundTaskId,undefined);
});
