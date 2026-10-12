import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {CatalogStore} from '../src/usage/catalog-store.ts';
import {apiEquivalent,bundledCatalog,validateCatalog} from '../src/usage/pricing.ts';
import {proposeCatalog} from '../scripts/check-pricing.ts';

const counts={input:1000000,output:0,cacheRead:0,cacheWrite:0,cacheWrite1h:0,reasoning:0};
const response=(value:unknown)=>new Response(JSON.stringify(value));
const next=()=>({...structuredClone(bundledCatalog),version:'2026-10-12-updated',models:{...bundledCatalog.models,'gpt-6.1-sol':{...bundledCatalog.models['gpt-6.1-sol'],input:3}}});
const setup=()=>{const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE usage_events(id TEXT PRIMARY KEY)');return db;};
const bound=(db:DatabaseSync,id:string)=>(db.prepare('SELECT catalog_version FROM usage_pricing WHERE id=?').get(id) as {catalog_version:string}).catalog_version;

test('daily catalog downloads retain old usage rates and survive restart offline',async()=>{
 const db=setup();let calls=0;const catalog=next();
 try{
  db.prepare('INSERT INTO usage_events VALUES(?)').run('old');
  const store=new CatalogStore(db,'https://example.com/catalog.json',async()=>{calls++;return response(catalog);});store.bindExisting();
  await Promise.all([store.refresh(),store.refresh()]);store.bind('new');
  assert.equal(store.cost(bound(db,'old'),'gpt-6.1-sol',counts),2);assert.equal(store.cost(bound(db,'new'),'gpt-6.1-sol',counts),3);
  await store.refresh();assert.equal(calls,1);
  const restarted=new CatalogStore(db,'https://example.com/catalog.json',async()=>{throw new Error('offline');});
  assert.equal(restarted.status().version,catalog.version);await restarted.refresh();assert.equal(restarted.status().error,null);
  db.prepare("DELETE FROM pricing_state WHERE key='lastCheck'").run();await restarted.refresh();
  assert.equal(restarted.status().version,catalog.version);assert.equal(restarted.status().error,'offline');
  restarted.bind('new');assert.equal(bound(db,'old'),bundledCatalog.version);
 }finally{db.close();}
});
test('bad catalogs, rollback and reused version IDs never replace cached rates',async()=>{
 for(const candidate of [{...next(),currency:'EUR'},{...next(),verifiedAt:'2020-01-01'}, {...next(),version:bundledCatalog.version},{...next(),models:{'gpt-6.1-sol':{input:-1}}}]){
  const db=setup();try{const store=new CatalogStore(db,'https://example.com/pricing',async()=>response(candidate));await store.refresh();assert.equal(store.status().version,bundledCatalog.version);assert.ok(store.status().error);}finally{db.close();}
 }
 assert.throws(()=>validateCatalog({...bundledCatalog,verifiedAt:'2026-02-30'}));
 assert.throws(()=>validateCatalog({...bundledCatalog,sources:['https://example.com']}));
});
test('fetch failures and oversized responses are rate limited and preserve fallback',async()=>{
 for(const fetcher of [async()=>new Response('unavailable',{status:503}),async()=>new Response('x'.repeat(1024*1024+1)),async()=>{throw new Error('network');}]){
  const db=setup();let calls=0;try{const store=new CatalogStore(db,'https://example.com/pricing',async()=>{calls++;return fetcher();});await store.refresh();await store.refresh();assert.equal(calls,1);assert.equal(store.status().version,bundledCatalog.version);assert.ok(store.status().error);}finally{db.close();}
 }
 const db=setup();try{let calls=0;const store=new CatalogStore(db,'http://example.com',async()=>{calls++;return response(next());});await store.refresh();assert.equal(calls,0);assert.match(store.status().error!,/HTTPS/);}finally{db.close();}
});
test('baseline costs keep 1-hour cache writes distinct and unknown models unpriced',()=>{
 const c={...counts,input:0,cacheWrite:1000000,cacheWrite1h:500000};assert.equal(apiEquivalent('claude-opus-5-5',c),6.5);assert.equal(apiEquivalent('unknown',c),null);
});
const openai=`### Standard pricing data
| Model | Short context input | Short context cached input | Short context cache writes | Short context output | Long context input |
| --- | --- | --- | --- | --- | --- |
| gpt-6.1-sol | $2.00 | $0.10 | $2.50 | $10.00 | $4.00 |

### Batch pricing data
| Model | Short context input | Short context cached input | Short context cache writes | Short context output |
| --- | --- | --- | --- | --- |
| gpt-6.1-sol | $1.00 | $0.05 | $1.25 | $5.00 |
`;
const claude=`| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
| --- | --- | --- | --- | --- | --- |
| Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok<sup>2</sup> | $20 / MTok |
| Claude Haiku 5.5 (for prompts up to 100,000 tokens) | $0.10 / MTok | $0.125 / MTok | $0.20 / MTok | $0.01 / MTok | $0.50 / MTok |
| Claude Haiku 5.5 (for prompts over 100,000 tokens) | $0.50 / MTok | $0.625 / MTok | $1 / MTok | $0.05 / MTok | $2.50 / MTok |
`;
const small={...bundledCatalog,models:{'gpt-6.1-sol':bundledCatalog.models['gpt-6.1-sol'],'claude-opus-5-5':bundledCatalog.models['claude-opus-5-5']}};
test('official page proposals select standard prices and leave unsupported context tiers unpriced',()=>{
 const proposal=proposeCatalog(openai,claude,small,'2026-10-12');assert.deepEqual(proposal.catalog.models,small.models);assert.ok(proposal.notes.some(n=>n.includes('prompt-length')));
 assert.throws(()=>proposeCatalog(openai.replace('Standard pricing data','Something else'),claude,small,'2026-10-12'));
 assert.throws(()=>proposeCatalog(openai.replace('| gpt-6.1-sol | $2.00','| gpt-6.1-sol | ask us'),claude,small,'2026-10-12'));
 assert.throws(()=>proposeCatalog(openai,claude,{...small,models:{...small.models,'gpt-5.6-sol':bundledCatalog.models['gpt-5.6-sol']}},'2026-10-12'));
});
