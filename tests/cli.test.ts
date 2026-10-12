import { test } from 'node:test';import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';import { mkdtempSync, rmSync } from 'node:fs';import { tmpdir } from 'node:os';import { join, resolve } from 'node:path';
const cli=resolve('src/capture/cli.ts');
test('hook failures and oversized input are silent and successful',()=>{
 for(const input of ['bad-json','x'.repeat(262145)]){
 const r=spawnSync(process.execPath,[cli,'hook','--provider','claude','--spool','/dev/null/nope'],{input,encoding:'utf8'});
 assert.equal(r.status,0);assert.equal(r.stdout,'');assert.equal(r.stderr,'');}
});
test('report accepts empty store and collect rejects invalid bounds',()=>{
 const root=mkdtempSync(join(tmpdir(),'ade-cli-'));
 const r=spawnSync(process.execPath,[cli,'report','--database',join(root,'e.sqlite'),'--output',join(root,'report.html')],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
 const bad=spawnSync(process.execPath,[cli,'collect','--duration','-1','--output',root],{encoding:'utf8'});assert.notEqual(bad.status,0);rmSync(root,{recursive:true});
});
test('report destination is independent of the default database directory',()=>{
 const root=mkdtempSync(join(tmpdir(),'ade-report-'));const target=join(root,'report.html');
 const r=spawnSync(process.execPath,[cli,'report','--output',target],{encoding:'utf8',cwd:root,env:{...process.env,ADE_CAPTURE_OUTPUT:join(root,'data')}});
 assert.equal(r.status,0,r.stderr);rmSync(root,{recursive:true});
});
