import {openEventDatabase,isPackedEventDatabase} from '../capture/event-database.ts';
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
// Records per commit while importing one log file.
const usageBatchSize=2000;
// Hook rows read per pass when finding captured sessions; small enough to keep requests responsive.
const capturedBatchRows=20000;
export class UsageReader{
 private providers:Record<string,boolean>=Object.fromEntries(agents.map(agent=>[agent.id,true]));private pricing:CatalogStore;private db:DatabaseSync;private enabled=false;private job:Promise<void>|undefined;private timer:ReturnType<typeof setTimeout>|undefined;
 private limits:UsageSummary['limits']=[];private lastScan:number|null=null;private filesScanned=0;private error:string|null=null;
 private roots?:Array<{provider:string;accountId:string;path:string}>;private orca:typeof callOrca;private home:string;private ownsDatabase:boolean;
 private sessionFirst=new Map<string,number>();private childFirst=new Map<string,number>();private capturedRowid=0;private captured:Map<string,number>|undefined;private capturedLoaded=false;private eventId='event_id';private capturedPending=false;
 private summaryCache:{key:string;value:UsageSummary}|undefined;private generation=0;
 /**
  * Pass the collector's open connection to share it. A second connection's
  * commits change PRAGMA data_version, which the collector reads as foreign
  * writes that invalidate its summary caches.
  */
 constructor(database:string|DatabaseSync,roots?:Array<{provider:string;accountId:string;path:string}>,orca:typeof callOrca=callOrca,pricingUrl?:string,home:string=homedir()){
  this.roots=roots;this.orca=orca;this.home=home;
  this.ownsDatabase=typeof database==='string';
  this.db=typeof database==='string'?openEventDatabase(database):database;
  this.db.exec('PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS usage_events (id TEXT PRIMARY KEY, timestamp REAL NOT NULL, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS usage_cursors (path TEXT PRIMARY KEY, offset INTEGER NOT NULL, state TEXT NOT NULL);');
  this.pricing=new CatalogStore(this.db,pricingUrl);this.pricing.bindExisting();
 }
 configureProviders(providers:Record<string,boolean>){this.providers={...providers};}
 rebindPricing(){this.pricing.bindExisting();this.generation++;}
 start(){if(this.enabled)return;this.enabled=true;void this.refresh();}
 async stop(){this.enabled=false;clearTimeout(this.timer);await this.job;}
 async close(){await this.stop();if(this.ownsDatabase)this.db.close();}
 private async discoverRoots(){
  if(this.roots)return this.roots;
  const base=join(this.home,'Library/Application Support/orca'),roots=agents.map(agent=>({provider:agent.id,accountId:'default',path:join(this.home,agent.defaultUsagePath)}));
  for(const agent of agents){
   for(const directory of agent.orcaDirectories||[agent.id+'-accounts']){
    const folder=join(base,directory);for(const entry of await readdir(folder,{withFileTypes:true}).catch(()=>[]))if(entry.isDirectory()){
     for(const suffix of agent.usagePaths)roots.push({provider:agent.id,accountId:directory.endsWith('-profiles')?'profile:'+entry.name:entry.name,path:join(folder,entry.name,suffix)});
    }
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
  this.job=this.scan().catch(e=>{this.error=String(e);}).finally(()=>{this.job=undefined;this.generation++;if(this.enabled)this.timer=setTimeout(()=>{void this.refresh();},60000);});await this.job;
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
  const captured=await this.catchUpCaptured();if(!this.enabled)return;
  for(const root of (await this.discoverRoots()).filter(r=>this.providers[r.provider]))for await(const file of this.files(root.path)){
   if(!this.enabled)return;if(!this.providers[root.provider])continue;const canonical=await realpath(file).catch(()=>file);if(seen.has(canonical))continue;seen.add(canonical);
   if(![...captured.keys()].some(key=>key.startsWith(root.provider+':')&&canonical.includes(key.slice(root.provider.length+1))))continue;
   const info=await stat(canonical).catch(()=>null);if(!info||!info.size||info.mtimeMs<month.getTime())continue;
   const cursor=this.db.prepare('SELECT offset,state FROM usage_cursors WHERE path=?').get(canonical) as {offset:number;state:string}|undefined;
   if(cursor&&cursor.offset===info.size){this.filesScanned++;continue;}
   let offset=cursor&&cursor.offset<=info.size?cursor.offset:0;const state:ParserState&{skipping?:boolean}=offset&&cursor?JSON.parse(cursor.state):{};
   const stream=createReadStream(canonical,{start:offset,end:info.size-1,highWaterMark:65536});let pending=Buffer.alloc(0),skipping=state.skipping===true;
   let batch:UsageRecord[]=[],failed=false;
   // Records and their cursor commit together. A storage failure keeps the old
   // cursor, so the same lines are read again next scan instead of being lost.
   const flush=()=>{
    state.skipping=skipping;
    try{this.commit(batch,canonical,offset,JSON.stringify(state));batch=[];return true;}
    catch(error){failed=true;this.error=`Could not save token usage: ${String(error)}`;return false;}
   };
   try{for await(const chunk of stream){
    if(!this.enabled||!this.providers[root.provider])break;pending=Buffer.concat([pending,chunk as Buffer]);let at:number;
    while((at=pending.indexOf(10))>=0){
     const line=pending.subarray(0,at);offset+=at+1;pending=pending.subarray(at+1);
     if(skipping){skipping=false;continue;}
     let record:UsageRecord|undefined;
     try{record=parseUsage(root.provider,JSON.parse(line.toString('utf8')),state,root.accountId);}catch{continue;}
     const first=record?captured.get(record.provider+':'+record.sessionId):undefined;
     if(record&&first!==undefined&&record.timestamp>=Math.max(cutoff,first))batch.push(record);
    }
    if(pending.length>16*1024*1024){offset+=pending.length;pending=Buffer.alloc(0);skipping=true;this.error='Some oversized log records were skipped';}
    if(batch.length>=usageBatchSize&&!flush())break;
   }}finally{stream.destroy();}
   if(failed)continue;
   // Persist only complete lines; unfinished provider writes are retried next scan.
   if(flush())this.filesScanned++;
  }
  this.lastScan=Date.now()/1000;
 }
 /**
  * Sessions with hook events, and when each was first seen. Reading them decodes every hook
  * payload, which on a large packed history blocks the collector for seconds, so progress is
  * kept in the database and each call reads at most `limit` new rows.
  */
 private capturedSessions(limit=capturedBatchRows){
  this.loadCaptured();
  let changed=false,read=0;
  const rows=this.db.prepare(`SELECT rowid,${this.eventId} event_id,json_extract(payload,'$.provider') provider,json_extract(payload,'$.sessionId') sessionId,json_extract(payload,'$.agentId') agentId,json_extract(payload,'$.kind') kind,observed_at first FROM events WHERE rowid>? AND ${isPackedEventDatabase(this.db)?"source='hook'":"json_extract(payload,'$.source')='hook'"} ORDER BY rowid LIMIT ?`).all(this.capturedRowid,limit);
  const updates=new Map<string,number>();
  const earliest=(map:Map<string,number>,prefix:string,key:string,first:number)=>{const previous=map.get(key);if(previous===undefined||first<previous){map.set(key,first);updates.set(prefix+key,first);changed=true;}};
  let lastId='';
  for(const row of rows){
   read++;this.capturedRowid=Math.max(this.capturedRowid,Number(row.rowid));lastId=String(row.event_id);
   if(typeof row.provider!=='string')continue;
   if(typeof row.sessionId==='string')earliest(this.sessionFirst,'s:',row.provider+':'+row.sessionId,Number(row.first));
   if(row.kind==='child_start'&&typeof row.agentId==='string'&&agentById.get(row.provider)?.childSessionIds)earliest(this.childFirst,'c:',row.provider+':'+row.agentId,Number(row.first));
  }
  this.capturedPending=read>=limit;
  if(read)this.saveCaptured(updates,lastId);
  if(changed||!this.captured){this.captured=new Map([...this.sessionFirst,...this.childFirst]);this.generation++;}
  return this.captured;
 }
 /** Read every captured session, yielding between batches so requests are answered meanwhile. */
 private async catchUpCaptured(){
  let map=this.capturedSessions();
  while(this.capturedPending&&this.enabled){await new Promise(resolve=>setImmediate(resolve));map=this.capturedSessions();}
  return map;
 }
 /**
  * Restore saved progress. It is trusted only while the rows it covered are unchanged: a
  * restored, compacted or replaced history starts over.
  */
 private loadCaptured(){
  if(this.capturedLoaded)return;this.capturedLoaded=true;
  try{
   if(!(this.db.prepare('PRAGMA table_info(events)').all() as Array<{name:string}>).some(column=>column.name==='event_id'))this.eventId="''";
   this.db.exec('CREATE TABLE IF NOT EXISTS usage_captured_sessions (key TEXT PRIMARY KEY, first REAL NOT NULL); CREATE TABLE IF NOT EXISTS usage_captured_state (id INTEGER PRIMARY KEY CHECK (id=1), last_rowid INTEGER NOT NULL, last_event_id TEXT NOT NULL, covered INTEGER NOT NULL)');
   const state=this.db.prepare('SELECT last_rowid,last_event_id,covered FROM usage_captured_state WHERE id=1').get() as {last_rowid:number;last_event_id:string;covered:number}|undefined;
   const valid=state&&(this.db.prepare(`SELECT ${this.eventId} event_id FROM events WHERE rowid=?`).get(state.last_rowid) as {event_id:string}|undefined)?.event_id===state.last_event_id
    &&Number((this.db.prepare('SELECT count(*) n FROM events WHERE rowid<=?').get(state.last_rowid) as {n:number}).n)===Number(state.covered);
   if(!valid){this.db.exec('DELETE FROM usage_captured_sessions; DELETE FROM usage_captured_state');return;}
   for(const row of this.db.prepare('SELECT key,first FROM usage_captured_sessions').all() as Array<{key:string;first:number}>)
    (row.key.startsWith('c:')?this.childFirst:this.sessionFirst).set(row.key.slice(2),Number(row.first));
   this.capturedRowid=Number(state.last_rowid);
  }catch{/* Without saved progress the sessions are read from the start. */}
 }
 private saveCaptured(updates:Map<string,number>,lastId:string){
  const begin=!this.db.isTransaction;
  try{
   if(begin)this.db.exec('BEGIN');
   const write=this.db.prepare('INSERT INTO usage_captured_sessions VALUES(?,?) ON CONFLICT(key) DO UPDATE SET first=min(first,excluded.first)');
   for(const [key,first] of updates)write.run(key,first);
   const covered=Number((this.db.prepare('SELECT count(*) n FROM events WHERE rowid<=?').get(this.capturedRowid) as {n:number}).n);
   this.db.prepare('INSERT INTO usage_captured_state VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET last_rowid=excluded.last_rowid,last_event_id=excluded.last_event_id,covered=excluded.covered').run(this.capturedRowid,lastId,covered);
   if(begin)this.db.exec('COMMIT');
  }catch{if(begin&&this.db.isTransaction)this.db.exec('ROLLBACK');/* Progress is saved again with the next batch. */}
 }
 private commit(records:UsageRecord[],path:string,offset:number,state:string){
  const read=this.db.prepare('SELECT payload FROM usage_events WHERE id=?');
  const write=this.db.prepare('INSERT INTO usage_events VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,timestamp=excluded.timestamp');
  const begin=!this.db.isTransaction;if(begin)this.db.exec('BEGIN');
  try{
   for(const record of records){
    const existing=read.get(record.id) as {payload:string}|undefined;
    if(existing&&agentById.get(record.provider)?.dedupe==='first')continue;
    if(existing){const previous=JSON.parse(existing.payload);for(const key of Object.keys(emptyCounts()) as Array<keyof Counts>)record[key]=Math.max(record[key],previous[key]||0);record.timestamp=Math.min(record.timestamp,previous.timestamp);}
    write.run(record.id,record.timestamp,JSON.stringify(record));this.pricing.bind(record.id);
   }
   this.db.prepare('INSERT INTO usage_cursors VALUES(?,?,?) ON CONFLICT(path) DO UPDATE SET offset=excluded.offset,state=excluded.state').run(path,offset,state);
   if(begin)this.db.exec('COMMIT');
  }catch(error){if(begin&&this.db.isTransaction)this.db.exec('ROLLBACK');throw error;}
  if(records.length)this.generation++;
 }
 summary():UsageSummary{
  const captured=this.capturedSessions();
  // The tray asks often; reuse the aggregate until usage, sessions, pricing or the day changes.
  const key=`${this.generation}:${day(new Date())}:${Boolean(this.job)}`;
  if(this.summaryCache?.key===key)return {...this.summaryCache.value,limits:this.limits,scanning:Boolean(this.job),lastScan:this.lastScan,filesScanned:this.filesScanned,error:this.error};
  const days=new Map<string,UsageSummary['days'][number]>(),models=new Map<string,UsageSummary['models'][number]>();const month=new Date();month.setDate(1);month.setHours(0,0,0,0);
  for(const row of this.db.prepare('SELECT u.payload,p.catalog_version FROM usage_events u LEFT JOIN usage_pricing p ON p.id=u.id WHERE u.timestamp>=?').all(periodStart().getTime()/1000) as Array<{payload:string;catalog_version:string}>){
   const r:UsageRecord=JSON.parse(row.payload);const first=captured.get(r.provider+':'+r.sessionId);if(first===undefined||r.timestamp<first)continue;
   const date=day(new Date(r.timestamp*1000)),key=r.provider+date,tokens=tokenTotal(r),cost=this.pricing.cost(row.catalog_version,r.model,r);
   const d=days.get(key)||{date,provider:r.provider,tokens:0,usd:0,unpriced:0,counts:emptyCounts()};d.tokens+=tokens;d.usd+=cost||0;d.unpriced+=cost===null?tokens:0;for(const k of Object.keys(d.counts) as Array<keyof Counts>)d.counts[k]+=r[k];days.set(key,d);
   if(r.timestamp>=month.getTime()/1000){const m=models.get(r.provider+r.model)||{model:r.model,provider:r.provider,tokens:0,usd:0,unpriced:0};m.tokens+=tokens;m.usd+=cost||0;m.unpriced+=cost===null?tokens:0;models.set(r.provider+r.model,m);}
  }
  const value={days:[...days.values()].sort((a,b)=>a.date.localeCompare(b.date)),models:[...models.values()].sort((a,b)=>b.tokens-a.tokens),limits:this.limits,scanning:Boolean(this.job),lastScan:this.lastScan,filesScanned:this.filesScanned,error:this.error,pricingCheckedAt:this.pricing.status().verifiedAt,pricingSources:this.pricing.sources,pricing:this.pricing.status()};
  this.summaryCache={key,value};
  return value;
 }
}
