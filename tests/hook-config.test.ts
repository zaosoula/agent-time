import { test } from 'node:test';import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';import { join } from 'node:path';import { tmpdir } from 'node:os';
import { prepareConfig, applyConfig, restoreConfig } from '../src/capture/hook-config.ts';
test('hook configuration preserves existing and concurrently added hooks on rollback', () => {
 const root=mkdtempSync(join(tmpdir(),'ade-config-'));const path=join(root,'settings.json');
 const original={other:true,hooks:{Stop:[{hooks:[{type:'command',command:'existing'}]}]}};writeFileSync(path,JSON.stringify(original));
 const manifest=prepareConfig(path,'claude','our-command',['Stop','SessionStart']);applyConfig(manifest);
 const updated=JSON.parse(readFileSync(path,'utf8'));updated.hooks.Stop.push({hooks:[{type:'command',command:'concurrent'}]});writeFileSync(path,JSON.stringify(updated));
 restoreConfig(manifest);const restored=JSON.parse(readFileSync(path,'utf8'));assert.equal(restored.other,true);assert.equal(restored.hooks.Stop.length,2);assert.ok(!restored.hooks.SessionStart);rmSync(root,{recursive:true});
});
test('changed owned hooks refuse rollback and conflicting originals refuse installation', () => {
 const root=mkdtempSync(join(tmpdir(),'ade-config-'));const path=join(root,'settings.json');writeFileSync(path,'{}');
 const m=prepareConfig(path,'claude','ours',['Stop']);writeFileSync(path,'{"other":true}');assert.throws(()=>applyConfig(m),/changed/);
 writeFileSync(path,'{}');applyConfig(m);const x=JSON.parse(readFileSync(path,'utf8'));x.hooks.Stop[0].hooks[0].command='changed';writeFileSync(path,JSON.stringify(x));assert.throws(()=>restoreConfig(m),/changed/);rmSync(root,{recursive:true});
});
