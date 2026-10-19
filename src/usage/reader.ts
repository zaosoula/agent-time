import {DatabaseSync} from 'node:sqlite';import {homedir} from 'node:os';import {join} from 'node:path';
import {readdir,stat,realpath} from 'node:fs/promises';import {createReadStream} from 'node:fs';
import {parseUsage,tokenTotal,type ParserState,type UsageRecord,type Counts} from './parser.ts';
import {CatalogStore,type PricingStatus} from './catalog-store.ts';
import {callOrca,object,orcaCliAvailable} from '../capture/orca.ts';
import {agents,agentById} from '../capture/sources/agent-registry.ts';
export interface UsageSummary{days:Array<{date:string;provider:string;tokens:number;usd:number;unpriced:number;counts:Counts}>;models:Array<{model:string;provider:string;tokens:number;usd:number;unpriced:number}>;limits:Array<{provider:string;accountId:string;status:string;updatedAt:number|null;session:any;weekly:any}>;scanning:boolean;lastScan:number|null;filesScanned:number;error:string|null;pricingCheckedAt:string;pricingSources:string[];pricing:PricingStatus;}
const day=(date:Date)=>`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
const emptyCounts=():Counts=>({input:0,output:0,cacheRead:0,cacheWrite:0,cacheWrite1h:0,reasoning:0});
const periodStart=()=>{const month=new Date();month.setDate(1);month.setHours(0,0,0,0);const week=new Date();week.setDate(week.getDate()-(week.getDay()+6)%7);week.setHours(0,0,0,0);return new Date(Math.min(month.getTime(),week.getTime()));};
export class UsageReader{
 private providers:Record<string,boolean>=Object.fromEntries(agents.map(agent=>[agent.id,true]));private pricing:CatalogStore;private db:DatabaseSync;private enabled=false;private job:Promise<void>|undefined;private timer:ReturnType<typeof setTimeout>|undefined;
 private limits:UsageSummary['limits']=[];private lastScan:number|null=null;private filesScanned=0;private error:string|null=null;
 private roots?:Array<{provider:string;accountId:string;path:string}>;private orca:typeof callOrca;
 constructor(database:string,roots?:Array<{provider:string;accountId:string;path:string}>,orca:typeof callOrca=callOrca,pricingUrl?:string){
  this.roots=roots;this.orca=orca;
  this.db=new DatabaseSync(database);this.db.exec('PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS usage_events (id TEXT PRIMARY KEY, timestamp REAL NOT NULL, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS usage_cursors (path TEXT PRIMARY KEY, offset INTEGER NOT NULL, state TEXT NOT NULL);');
  this.pricing=new CatalogStore(this.db,pricingUrl);this.pricing.bindExisting();
 }
 configureProviders(providers:Record<string,boolean>){this.providers={...providers};}
 start(){if(this.enabled)return;this.enabled=true;void this.refresh();}
 async stop(){this.enabled=false;clearTimeout(this.timer);await this.job;}
 async close(){await this.stop();this.db.close();}
 private async discoverRoots(){
  if(this.roots)return this.roots;
  const base=join(homedir(),'Library/Application Support/orca'),roots=agents.map(agent=>({provider:agent.id,accountId:'default',path:join(homedir(),agent.defaultUsagePath)}));
  for(const agent of agents){
   const folder=join(base,agent.id+'-accounts');for(const entry of await readdir(folder,{withFileTypes:true}).catch(()=>[]))if(entry.isDirectory()){
    for(const suffix of agent.usagePaths)roots.push({provider:agent.id,accountId:entry.name,path:join(folder,entry.name,suffix)});
   }
  }return roots;
 }
 private async *files(folder:string):AsyncGenerator<string>{
  for(const entry of await readdir(folder,{withFileTypes:true}).catch(()=>[])){
   if(!this.enabled)return;const path=join(folder,entry.name);
   if(entry.isDirectory())yield* this.files(path);else if(entry.isFile()&&entry.name.endsWith('.jsonl'))yield path;
  }
 }
 async refresh(){
  if(this.job||!this.enabled)return;
  clearTimeout(this.timer);this.timer=undefined;
  this.job=this.scan().catch(e=>{this.error=String(e);}).finally(()=>{this.job=undefined;if(this.enabled)this.timer=setTimeout(()=>{void this.refresh();},60000);});await this.job;
 }
 private async scan(){
  this.error=null;this.filesScanned=0;
  await this.pricing.refresh();if(!this.enabled)return;
  if(this.orca!==callOrca||orcaCliAvailable()){
   try{
    const receipt=object(await this.orca(['account','list','--json']));if(!receipt.ok)throw new Error('Orca account usage unavailable');
    const r=object(receipt.result),limits=object(r.rateLimits);this.limits=this.limits.filter(l=>!this.providers[l.provider]);
    const window=(v:any)=>v&&typeof v.usedPercent==='number'?{usedPercent:Math.max(0,Math.min(100,v.usedPercent)),resetsAt:typeof v.resetsAt==='number'?v.resetsAt:null,windowMinutes:typeof v.windowMinutes==='number'?v.windowMinutes:null}:null;
    for(const agent of agents.filter(agent=>agent.orcaLimits)){
     const provider=agent.id;if(!this.providers[provider])continue;
     const candidates=[{...object(limits[provider]),accountId:r[provider]?.activeAccountId||'default'},...(Array.isArray(limits['inactive'+provider[0].toUpperCase()+provider.slice(1)+'Accounts'])?limits['inactive'+provider[0].toUpperCase()+provider.slice(1)+'Accounts']:[])];
     for(const v of candidates)this.limits.push({provider,accountId:String(v.accountId||'unknown'),status:String(v.status||'unknown'),updatedAt:typeof v.updatedAt==='number'?v.updatedAt:null,session:window(v.session),weekly:window(v.weekly)});
    }
   }catch{this.error='Account limits unavailable; local token history can still be read';}
  }else this.limits=[];
  const month=periodStart();const cutoff=month.getTime()/1000;const seen=new Set<string>();
  const captured=this.capturedSessions();
  for(const root of (await this.discoverRoots()).filter(r=>this.providers[r.provider]))for await(const file of this.files(root.path)){
   if(!this.enabled)return;if(!this.providers[root.provider])continue;const canonical=await realpath(file).catch(()=>file);if(seen.has(canonical))continue;seen.add(canonical);
   if(![...captured.keys()].some(key=>key.startsWith(root.provider+':')&&canonical.includes(key.slice(root.provider.length+1))))continue;
   const info=await stat(canonical).catch(()=>null);if(!info||!info.size||info.mtimeMs<month.getTime())continue;
   const cursor=this.db.prepare('SELECT offset,state FROM usage_cursors WHERE path=?').get(canonical) as {offset:number;state:string}|undefined;
   if(cursor&&cursor.offset===info.size){this.filesScanned++;continue;}
   let offset=cursor&&cursor.offset<=info.size?cursor.offset:0;const state:ParserState&{skipping?:boolean}=offset&&cursor?JSON.parse(cursor.state):{};
   const stream=createReadStream(canonical,{start:offset,end:info.size-1,highWaterMark:65536});let pending=Buffer.alloc(0),skipping=state.skipping===true;
   try{for await(const chunk of stream){
    if(!this.enabled||!this.providers[root.provider])break;pending=Buffer.concat([pending,chunk as Buffer]);let at:number;
    while((at=pending.indexOf(10))>=0){
     const line=pending.subarray(0,at);offset+=at+1;pending=pending.subarray(at+1);
     if(skipping){skipping=false;continue;}
     try{const record=parseUsage(root.provider,JSON.parse(line.toString('utf8')),state,root.accountId);const first=record?captured.get(record.provider+':'+record.sessionId):undefined;if(record&&first!==undefined&&record.timestamp>=Math.max(cutoff,first))this.put(record);}catch{}
    }
    if(pending.length>16*1024*1024){offset+=pending.length;pending=Buffer.alloc(0);skipping=true;this.error='Some oversized log records were skipped';}
   }}finally{stream.destroy();}
   // Persist only complete lines; unfinished provider writes are retried next scan.
   state.skipping=skipping;this.db.prepare('INSERT INTO usage_cursors VALUES(?,?,?) ON CONFLICT(path) DO UPDATE SET offset=excluded.offset,state=excluded.state').run(canonical,offset,JSON.stringify(state));this.filesScanned++;
  }
  this.lastScan=Date.now()/1000;
 }
 private capturedSessions(){
  const result=new Map<string,number>();
  for(const r of this.db.prepare("SELECT json_extract(payload,'$.provider') provider,json_extract(payload,'$.sessionId') sessionId,MIN(observed_at) first FROM events WHERE json_extract(payload,'$.source')='hook' AND json_extract(payload,'$.sessionId') IS NOT NULL GROUP BY 1,2").all() as Array<{provider:string;sessionId:string;first:number}>)result.set(r.provider+':'+r.sessionId,r.first);
  for(const agent of agents.filter(agent=>agent.childSessionIds))for(const r of this.db.prepare("SELECT json_extract(payload,'$.agentId') sessionId,MIN(observed_at) first FROM events WHERE json_extract(payload,'$.source')='hook' AND json_extract(payload,'$.provider')=? AND json_extract(payload,'$.kind')='child_start' AND json_extract(payload,'$.agentId') IS NOT NULL GROUP BY 1").all(agent.id) as Array<{sessionId:string;first:number}>)result.set(agent.id+':'+r.sessionId,r.first);
  return result;
 }
 private put(record:UsageRecord){
  const existing=this.db.prepare('SELECT payload FROM usage_events WHERE id=?').get(record.id) as {payload:string}|undefined;
  if(existing&&agentById.get(record.provider)?.dedupe==='first')return;
  if(existing){const previous=JSON.parse(existing.payload);for(const key of Object.keys(emptyCounts()) as Array<keyof Counts>)record[key]=Math.max(record[key],previous[key]||0);record.timestamp=Math.min(record.timestamp,previous.timestamp);}
  this.db.exec('BEGIN');
  try{this.db.prepare('INSERT INTO usage_events VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,timestamp=excluded.timestamp').run(record.id,record.timestamp,JSON.stringify(record));this.pricing.bind(record.id);this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 summary():UsageSummary{
  const days=new Map<string,UsageSummary['days'][number]>(),models=new Map<string,UsageSummary['models'][number]>();const month=new Date();month.setDate(1);month.setHours(0,0,0,0);const captured=this.capturedSessions();
  for(const row of this.db.prepare('SELECT u.payload,p.catalog_version FROM usage_events u LEFT JOIN usage_pricing p ON p.id=u.id WHERE u.timestamp>=?').all(periodStart().getTime()/1000) as Array<{payload:string;catalog_version:string}>){
   const r:UsageRecord=JSON.parse(row.payload);const first=captured.get(r.provider+':'+r.sessionId);if(first===undefined||r.timestamp<first)continue;
   const date=day(new Date(r.timestamp*1000)),key=r.provider+date,tokens=tokenTotal(r),cost=this.pricing.cost(row.catalog_version,r.model,r);
   const d=days.get(key)||{date,provider:r.provider,tokens:0,usd:0,unpriced:0,counts:emptyCounts()};d.tokens+=tokens;d.usd+=cost||0;d.unpriced+=cost===null?tokens:0;for(const k of Object.keys(d.counts) as Array<keyof Counts>)d.counts[k]+=r[k];days.set(key,d);
   if(r.timestamp>=month.getTime()/1000){const m=models.get(r.provider+r.model)||{model:r.model,provider:r.provider,tokens:0,usd:0,unpriced:0};m.tokens+=tokens;m.usd+=cost||0;m.unpriced+=cost===null?tokens:0;models.set(r.provider+r.model,m);}
  }
  return {days:[...days.values()].sort((a,b)=>a.date.localeCompare(b.date)),models:[...models.values()].sort((a,b)=>b.tokens-a.tokens),limits:this.limits,scanning:Boolean(this.job),lastScan:this.lastScan,filesScanned:this.filesScanned,error:this.error,pricingCheckedAt:this.pricing.status().verifiedAt,pricingSources:this.pricing.sources,pricing:this.pricing.status()};
 }
}
