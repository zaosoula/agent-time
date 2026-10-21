import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PrivacyExclusions,validateExclusions,isExcluded} from '../src/capture/privacy-exclusions.ts';
import {Collector} from '../src/capture/collector.ts';

test('exact app and site exclusions discard matching samples but leave other activity',()=>{
 const list=validateExclusions([{kind:'app',value:'com.example.Editor'},{kind:'site',value:'Example.COM'}]);
 assert.equal(isExcluded({foregroundBundleId:'com.example.Editor'},list),true);
 assert.equal(isExcluded({foregroundBundleId:'com.example.Other'},list),false);
 assert.equal(isExcluded({browserUrl:'https://example.com/private?query=secret'},list),true);
 assert.equal(isExcluded({browserUrl:'https://sub.example.com/'},list),false);
 assert.equal(isExcluded({browserDomain:'example.com'},list),true);
 assert.equal(isExcluded({browserUrl:'https://notexample.com/'},list),false);
});
test('excluded foreground samples never enter event storage',async()=>{
 const output=mkdtempSync(join(tmpdir(),'agent-time-privacy-collector-'));const collector=new Collector(output);
 try{
  collector.setPrivacyExclusions([{kind:'app',value:'com.example.Secret'}]);
  (collector as any).onProbeLine(JSON.stringify({kind:'activity',foregroundBundleId:'com.example.Secret',foregroundName:'Secret',idleSeconds:0,uptime:100}));
  assert.equal(collector.store.count(),0);
  assert.equal(collector.status().macos?.excluded,true);
  (collector as any).onProbeLine(JSON.stringify({kind:'activity',foregroundBundleId:'com.example.Visible',foregroundName:'Visible',idleSeconds:0,uptime:101}));
  assert.equal(collector.store.count(),1);
 }finally{await collector.close();rmSync(output,{recursive:true});}
});
test('visible activity cannot bridge an excluded foreground period',async()=>{
 const output=mkdtempSync(join(tmpdir(),'agent-time-privacy-boundary-'));const collector=new Collector(output);
 try{
  collector.setPrivacyExclusions([{kind:'app',value:'com.example.Secret'}]);
  const observe=(bundle:string)=>{(collector as any).onProbeLine(JSON.stringify({kind:'activity',foregroundBundleId:bundle,foregroundName:bundle,idleSeconds:0,uptime:100}));};
  observe('com.example.Visible');observe('com.example.Secret');observe('com.example.Visible');observe('com.example.Visible');
  const events=collector.store.events();
  assert.equal(events.length,3);
  assert.ok(events.every(event=>event.data?.foregroundBundleId==='com.example.Visible'));
  assert.notEqual(events[0]?.collectorEpoch,events[1]?.collectorEpoch);
  assert.equal(events[1]?.collectorEpoch,events[2]?.collectorEpoch);
  assert.ok(collector.summary().intervals.filter(interval=>interval.state==='human').every(interval=>interval.sourceEventIds[0]!==events[0]?.eventId));
 }finally{await collector.close();rmSync(output,{recursive:true});}
});
test('site exclusions fail closed for browser samples without a detected hostname',async()=>{
 const output=mkdtempSync(join(tmpdir(),'agent-time-privacy-unknown-site-'));const collector=new Collector(output);
 try{
  collector.setPrivacyExclusions([{kind:'site',value:'example.com'}]);
  const observe=(fields:Record<string,unknown>)=>{(collector as any).onProbeLine(JSON.stringify({kind:'activity',foregroundBundleId:'com.apple.Safari',foregroundName:'Safari',idleSeconds:0,uptime:100,...fields}));};
  observe({});
  assert.equal(collector.store.count(),0);
  assert.equal(collector.status().macos?.excluded,true);
  observe({browserDomain:'other.example'});
  assert.equal(collector.store.count(),1);
  observe({browserDomain:'example.com'});
  assert.equal(collector.store.count(),1);
 }finally{await collector.close();rmSync(output,{recursive:true});}
});
test('privacy exclusions are validated and persisted privately',()=>{
 const output=mkdtempSync(join(tmpdir(),'agent-time-privacy-'));
 try{
  const store=new PrivacyExclusions(output);
  assert.throws(()=>store.replace([{kind:'site',value:'example.com/path'}]));
  assert.throws(()=>store.replace([{kind:'app',value:'com.example.App'},{kind:'app',value:'com.example.App'}]));
  store.replace([{kind:'site',value:'Example.COM'}]);
  assert.deepEqual(new PrivacyExclusions(output).list(),[{kind:'site',value:'example.com'}]);
  assert.deepEqual(JSON.parse(readFileSync(join(output,'privacy-exclusions.json'),'utf8')),[{kind:'site',value:'example.com'}]);
 }finally{rmSync(output,{recursive:true});}
});
