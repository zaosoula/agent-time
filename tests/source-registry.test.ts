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
