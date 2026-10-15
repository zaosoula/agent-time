import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {stageBetaRelease} from '../scripts/publish-beta.mjs';
test('staging keeps a signed version immutable and does not promote the live feed',()=>{
 const dir=mkdtempSync(join(tmpdir(),'agent-time-feed-'));
 try{
  const archive=join(dir,'Agent Time.app.tar.gz'),signaturePath=archive+'.sig';
  writeFileSync(archive,'candidate archive');writeFileSync(signaturePath,'signed-content');
  const output=join(dir,'out');
  stageBetaRelease({version:'0.2.0-beta.2',archive,signaturePath,notes:'Capture fix',archiveUrl:'https://updates.example.test/beta/0.2.0-beta.2/Agent%20Time.app.tar.gz',output});
  const candidate=JSON.parse(readFileSync(join(output,'latest.json.candidate'),'utf8'));
  assert.equal(candidate.platforms['darwin-aarch64'].signature,'signed-content');
  assert.equal(readFileSync(join(output,'0.2.0-beta.2','Agent Time.app.tar.gz'),'utf8'),'candidate archive');
  assert.equal(existsSync(join(output,'latest.json')),false);
  assert.throws(()=>stageBetaRelease({version:'0.2.0-beta.2',archive,signaturePath,notes:'Other',archiveUrl:'https://updates.example.test/beta/0.2.0-beta.2/Agent%20Time.app.tar.gz',output}),/already exists/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
