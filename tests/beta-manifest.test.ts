import {test} from 'node:test';
import assert from 'node:assert/strict';
import {makeBetaManifest,isNewerBetaVersion} from '../scripts/beta-manifest.mjs';
test('the beta feed names only the signed Apple Silicon artifact',()=>{
 const result=makeBetaManifest({version:'0.2.0-beta.2',notes:'Capture fix',url:'https://updates.example.test/beta/0.2.0-beta.2/Agent-Time.app.tar.gz',signature:'signed-content'});
 assert.deepEqual(result,{version:'0.2.0-beta.2',notes:'Capture fix',platforms:{'darwin-aarch64':{url:'https://updates.example.test/beta/0.2.0-beta.2/Agent-Time.app.tar.gz',signature:'signed-content'}}});
});
test('the beta feed refuses insecure or incomplete artifacts',()=>{
 const good={version:'0.2.0-beta.2',notes:'',url:'https://updates.example.test/beta/app.tar.gz',signature:'sig'};
 assert.throws(()=>makeBetaManifest({...good,url:'http://updates.example.test/app.tar.gz'}),/HTTPS/);
 assert.throws(()=>makeBetaManifest({...good,signature:''}),/signature/);
 assert.throws(()=>makeBetaManifest({...good,version:'0.1.0'}),/beta version/);
});
test('publication only advances a valid beta version',()=>{
 assert.equal(isNewerBetaVersion('0.2.0-beta.2','0.2.0-beta.1'),true);
 assert.equal(isNewerBetaVersion('0.3.0-beta.1','0.2.9-beta.8'),true);
 assert.equal(isNewerBetaVersion('0.2.0-beta.1','0.2.0-beta.1'),false);
 assert.equal(isNewerBetaVersion('0.2.0-beta.1','0.2.0-beta.2'),false);
 assert.equal(isNewerBetaVersion('0.2.0','0.2.0-beta.1'),false);
});
