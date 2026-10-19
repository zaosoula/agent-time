import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

test('native widget hides missing-day and expired summaries while accepting zero activity',{skip:process.platform!=='darwin'},()=>{
 const dir=mkdtempSync(join(tmpdir(),'agent-time-widget-test-'));
 try{
  const executable=join(dir,'widget-snapshot-tests');
  execFileSync('swiftc',['-target','arm64-apple-macos13.5','native/widget/Snapshot.swift','tests/native/WidgetSnapshotTests.swift','-o',executable]);
  assert.match(execFileSync(executable,{encoding:'utf8'}),/passed/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
