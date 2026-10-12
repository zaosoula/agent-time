import type {DatabaseSync} from 'node:sqlite';
import {apiEquivalent,bundledCatalog,validateCatalog,type PricingCatalog} from './pricing.ts';
import type {Counts} from './parser.ts';

export interface PricingStatus {version:string;verifiedAt:string;lastCheck:number|null;stale:boolean;configured:boolean;error:string|null;}
export const defaultCatalogUrl='https://raw.githubusercontent.com/zaosoula/agent-time/main/src/usage/catalog.json';
const daily=86400000;
export class CatalogStore {
 private db:DatabaseSync;private url:string|undefined;private fetcher:typeof fetch;private catalog:PricingCatalog;
 private catalogs=new Map<string,PricingCatalog>();private pending:Promise<void>|undefined;
 constructor(db:DatabaseSync,url=process.env.ADE_PRICING_CATALOG_URL??defaultCatalogUrl,fetcher:typeof fetch=fetch){
  this.db=db;this.url=url;this.fetcher=fetcher;
  db.exec('CREATE TABLE IF NOT EXISTS pricing_catalogs (version TEXT PRIMARY KEY,payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS usage_pricing (id TEXT PRIMARY KEY,catalog_version TEXT NOT NULL); CREATE TABLE IF NOT EXISTS pricing_state (key TEXT PRIMARY KEY,value TEXT NOT NULL);');
  this.save(bundledCatalog);
  this.catalog=this.load(this.state('active')||bundledCatalog.version)||bundledCatalog;
  if(this.catalog.verifiedAt<bundledCatalog.verifiedAt){this.catalog=bundledCatalog;this.set('active',bundledCatalog.version);}
 }
 private state(key:string):string|undefined{return (this.db.prepare('SELECT value FROM pricing_state WHERE key=?').get(key) as {value:string}|undefined)?.value;}
 private set(key:string,value:string){this.db.prepare('INSERT INTO pricing_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value);}
 private load(version:string):PricingCatalog|undefined{
  if(this.catalogs.has(version))return this.catalogs.get(version);
  const row=this.db.prepare('SELECT payload FROM pricing_catalogs WHERE version=?').get(version) as {payload:string}|undefined;
  if(!row)return;const c=validateCatalog(JSON.parse(row.payload));this.catalogs.set(version,c);return c;
 }
 private save(c:PricingCatalog){
  const previous=this.load(c.version);
  if(previous&&JSON.stringify(previous)!==JSON.stringify(c))throw new Error('Pricing version already exists with different rates');
  this.db.prepare('INSERT OR IGNORE INTO pricing_catalogs VALUES(?,?)').run(c.version,JSON.stringify(c));this.catalogs.set(c.version,c);
 }
 // Existing records receive bundled rates before the first remote update.
 bindExisting(){this.db.prepare('INSERT OR IGNORE INTO usage_pricing SELECT id,? FROM usage_events').run(bundledCatalog.version);}
 bind(id:string){this.db.prepare('INSERT OR IGNORE INTO usage_pricing VALUES(?,?)').run(id,this.catalog.version);}
 cost(version:string,model:string,counts:Counts){const c=this.load(version);return c?apiEquivalent(model,counts,c):null;}
 status():PricingStatus{
  const checked=Number(this.state('lastCheck'))||null;
  return {version:this.catalog.version,verifiedAt:this.catalog.verifiedAt,lastCheck:checked,stale:Date.now()-Date.parse(this.catalog.verifiedAt)>30*daily,configured:Boolean(this.url),error:this.state('error')||null};
 }
 get sources(){return this.catalog.sources;}
 async refresh(){if(!this.url)return;if(this.pending)return this.pending;this.pending=this.update().finally(()=>{this.pending=undefined;});return this.pending;}
 private async update(){
  const now=Date.now(),last=Number(this.state('lastCheck'))||0;
  // Includes failed attempts, and survives relaunches.
  if(now-last<daily)return;this.set('lastCheck',String(now));
  try{
   const url=new URL(this.url!);if(url.protocol!=='https:'||url.username||url.password)throw new Error('Catalog URL must use HTTPS without credentials');
   const response=await this.fetcher(url,{signal:AbortSignal.timeout(10000),redirect:'error'});
   if(!response.ok)throw new Error(`Catalog HTTP ${response.status}`);
   const reader=response.body?.getReader();if(!reader)throw new Error('Empty catalog response');
   const chunks:Uint8Array[]=[];let size=0;
   try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>1024*1024)throw new Error('Catalog exceeds 1 MiB');chunks.push(part.value);}}finally{await reader.cancel();}
   const c=validateCatalog(JSON.parse(Buffer.concat(chunks).toString('utf8')));
   if(c.verifiedAt<this.catalog.verifiedAt)throw new Error('Catalog is older than cached rates');
   this.save(c);this.set('active',c.version);this.catalog=c;this.set('error','');
  }catch(e){this.set('error',e instanceof Error?e.message:'Pricing update failed');}
 }
}
