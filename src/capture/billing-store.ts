import type {DatabaseSync} from 'node:sqlite';
import {isAbsolute} from 'node:path';
import {projectPathFromWorktree} from './website-resolver.ts';
import type {BillingProject,BillingReport} from './billing-types.ts';

const object=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid billing object');return value as Record<string,unknown>;};
const text=(value:unknown,max=256):string=>{if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u001f]/.test(value))throw new Error('Invalid billing text');return value.trim();};
const date=(value:unknown):string=>{if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value+'T00:00:00Z'))||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)throw new Error('Invalid billing date');return value;};
const decimal=(value:unknown):string=>{if(typeof value!=='string'||!/^(?:0|[1-9]\d{0,17})(?:\.\d{1,12})?$/.test(value))throw new Error('Invalid billing decimal amount');return value;};
const weight=(value:unknown):string=>{if(typeof value==='string'&&/^(?:0|[1-9]\d{0,17})\/[1-9]\d{0,17}$/.test(value))return value;return decimal(value);};
const limit=(value:unknown,label:string):number|null=>{if(value===null)return null;if(typeof value!=='number'||!Number.isInteger(value)||value<1||value>1440)throw new Error(`Invalid billing ${label} minutes`);return value;};
const strings=(value:unknown,max=256):string[]=>{if(!Array.isArray(value)||value.length>500)throw new Error('Invalid billing source list');return [...new Set(value.map(item=>text(item,max)))];};
/** Stable serialization makes immutable records independent of object key order. */
function canonical(value:unknown):string {if(Array.isArray(value))return '['+value.map(item=>item===undefined?'null':canonical(item)).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).filter(key=>(value as Record<string,unknown>)[key]!==undefined).sort().map(key=>JSON.stringify(key)+':'+canonical((value as Record<string,unknown>)[key])).join(',')+'}';return JSON.stringify(value);}
export function validateBillingProject(value:unknown):BillingProject{
 if(Buffer.byteLength(JSON.stringify(value)??'', 'utf8')>262144)throw new Error('Billing configuration exceeds the size limit');
 const p=object(value),sources=object(p.sources),timezone=text(p.timezone,100);
 try{new Intl.DateTimeFormat('en',{timeZone:timezone}).format(0);}catch{throw new Error('Invalid billing timezone');}
 if(!Array.isArray(p.policies)||!p.policies.length||p.policies.length>500)throw new Error('At least one billing policy is required');
 const ids=new Set<string>();let previous='';
 const policies=p.policies.map(value=>{
  const item=object(value),id=text(item.id),effectiveFrom=date(item.effectiveFrom),rounding=object(item.rounding),fees=object(item.aiFees);
  if(ids.has(id)||effectiveFrom<previous)throw new Error('Billing policies must have unique IDs and ascending effective dates');ids.add(id);previous=effectiveFrom;
  if(!['overlapMergedWall','humanActive','weightedAgentOnly','weightedAgentRunning'].includes(String(item.basis)))throw new Error('Invalid billing basis');
  if(item.countingMode!==undefined&&item.countingMode!=='minutes'&&item.countingMode!=='seconds')throw new Error('Invalid billing counting mode');
  if(typeof item.currency!=='string'||!/^[A-Z]{3}$/.test(item.currency))throw new Error('Invalid billing currency');
  if(![1,15,60].includes(Number(rounding.minutes))||typeof rounding.minutes!=='number'||!['nearest','up','down'].includes(String(rounding.mode))||!['day','period'].includes(String(rounding.scope)))throw new Error('Invalid billing rounding');
  if(!['none','actual','flat'].includes(String(fees.mode)))throw new Error('Invalid billing AI fee');
  if(fees.mode==='flat'&&!['day','period'].includes(String(fees.scope)))throw new Error('Invalid billing flat fee scope');
  return {id,effectiveFrom,...(item.countingMode===undefined?{}:{countingMode:item.countingMode}),basis:item.basis,currency:item.currency,hourlyRate:item.hourlyRate===null?null:decimal(item.hourlyRate),agentOnlyHourlyRate:item.agentOnlyHourlyRate===null?null:decimal(item.agentOnlyHourlyRate),agentWeight:weight(item.agentWeight),rounding:{minutes:rounding.minutes,mode:rounding.mode,scope:rounding.scope},dailyCapMinutes:limit(item.dailyCapMinutes,'daily cap'),presenceWindowMinutes:limit(item.presenceWindowMinutes,'presence window'),aiFees:fees.mode==='flat'?{mode:'flat',amount:decimal(fees.amount),scope:fees.scope}:{mode:fees.mode}};
 }) as BillingProject['policies'];
 const repositories=strings(sources.repositories,4096).map(path=>{if(!isAbsolute(path)||/[*?\[\]{}]/.test(path))throw new Error('Billing repository must be an absolute path without glob patterns');return projectPathFromWorktree(path);});
 const revision=p.revision;if(revision!==undefined&&(!Number.isSafeInteger(revision)||Number(revision)<1))throw new Error('Invalid billing revision');
 return {id:text(p.id),name:text(p.name),aliases:strings(p.aliases),sources:{repositories:[...new Set(repositories)],workspaceIds:strings(sources.workspaceIds,4096),reportedProjects:strings(sources.reportedProjects)},timezone,policies,...(revision===undefined?{}:{revision:Number(revision)})};
}
export function ensureBillingSchema(db:DatabaseSync):void{
 db.exec(`CREATE TABLE IF NOT EXISTS billing_projects (id TEXT PRIMARY KEY,revision INTEGER NOT NULL,payload TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS billing_policies (project_id TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(project_id,id));
 CREATE TABLE IF NOT EXISTS billing_reports (id TEXT PRIMARY KEY,project_id TEXT NOT NULL,payload TEXT NOT NULL);`);
}
function billingSourceMatches(projects:BillingProject[],source:{workspaceId?:string|null;path?:string|null;reportedProject?:string|null}):BillingProject[]{
 const candidate=source.path&&isAbsolute(source.path)?source.path:source.workspaceId?.split('::').at(-1);
 const path=candidate&&isAbsolute(candidate)?projectPathFromWorktree(candidate):null;
 const roots=new Map<string,number>();let longest=-1;
 if(path)for(const project of projects)for(const candidate of project.sources.repositories){
  const root=projectPathFromWorktree(candidate);
  if(path===root||path.startsWith(root==='/'?'/':root+'/')){const specificity=root.length;roots.set(project.id,Math.max(roots.get(project.id)??-1,specificity));longest=Math.max(longest,specificity);}
 }
 // A context may declare the configured identity rather than an additional source name.
 // Retain every match so case/name collisions and conflicting path ownership remain errors.
 const identity=source.reportedProject?.trim().toLowerCase();
 return projects.filter(p=>Boolean(identity&&[p.id,p.name,...p.aliases].some(name=>name.toLowerCase()===identity)||source.workspaceId&&p.sources.workspaceIds.includes(source.workspaceId)||source.reportedProject&&p.sources.reportedProjects.includes(source.reportedProject)||longest>=0&&roots.get(p.id)===longest));
}
export function billingProjectForSource(projects:BillingProject[],source:{workspaceId?:string|null;path?:string|null;reportedProject?:string|null}):BillingProject|null{
 const matches=billingSourceMatches(projects,source);
 if(matches.length>1)throw new Error('Ambiguous billing project source');return matches[0]??null;
}
export function validateBillingReport(report:BillingReport):void{
  text(report.reportId);text(report.projectId);const snapshot=validateBillingProject(report.projectSnapshot);
  if(snapshot.id!==report.projectId||report.projectName!==snapshot.name||report.timezone!==snapshot.timezone||date(report.fromDate)>date(report.toDate)||!Number.isSafeInteger(report.calculationVersion)||report.calculationVersion<1||!Number.isFinite(Date.parse(report.createdAt)))throw new Error('Invalid billing report');
  if(report.currency!==null&&(typeof report.currency!=='string'||!/^[A-Z]{3}$/.test(report.currency)))throw new Error('Invalid billing report currency');
  if(!Array.isArray(report.days)||!report.quality||typeof report.quality.complete!=='boolean'||!Array.isArray(report.quality.warnings)||report.quality.warnings.some(w=>typeof w!=='string')||typeof report.explanation!=='string')throw new Error('Invalid billing report shape');
  for(const amounts of [report.totals,...report.days]){
   object(amounts);
   for(const key of ['humanActiveSeconds','agentWallSeconds','agentOnlyWallSeconds','agentRunningSeconds','overlapMergedWallSeconds','excludedSeconds','unknownSeconds','crossProjectOverlapSeconds','eligibleSeconds','billableSeconds','roundingSeconds'] as const)if(typeof amounts[key]!=='number'||!Number.isFinite(amounts[key])||key!=='roundingSeconds'&&amounts[key]<0)throw new Error('Invalid billing report seconds');
   for(const key of ['rawEligibleSeconds','countingAdjustmentSeconds'] as const)if(amounts[key]!==undefined&&(typeof amounts[key]!=='number'||!Number.isFinite(amounts[key])||amounts[key]!<0))throw new Error('Invalid billing report counting seconds');
   for(const key of ['timeAmount','aiAmount','totalAmount'] as const)if(amounts[key]!==null)decimal(amounts[key]);
   decimal(amounts.aiKnownAmount);
  }
  if(report.countingModes!==undefined&&(!Array.isArray(report.countingModes)||report.countingModes.some(mode=>!['minutes','seconds'].includes(mode))))throw new Error('Invalid billing report counting modes');
  let previous='';for(const day of report.days){if(day.countingMode!==undefined&&!['minutes','seconds'].includes(day.countingMode)||date(day.date)<report.fromDate||day.date>report.toDate||day.date<=previous||day.policyId!==null&&!snapshot.policies.some(p=>p.id===day.policyId)||!Array.isArray(day.warnings)||day.warnings.some(w=>typeof w!=='string'))throw new Error('Invalid billing report day');previous=day.date;}

}
export class BillingStore{
 private db:DatabaseSync;
 constructor(db:DatabaseSync){this.db=db;}
 private has(table:string):boolean{return Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));}
 listProjects():BillingProject[]{return this.has('billing_projects')?this.db.prepare('SELECT payload FROM billing_projects ORDER BY id').all().map(row=>JSON.parse(String(row.payload)) as BillingProject):[];}
 resolveProject(alias:string):BillingProject{
  text(alias,4096);const projects=this.listProjects(),sources=new Set(billingSourceMatches(projects,{path:alias,workspaceId:alias,reportedProject:alias}).map(p=>p.id));
  const matches=projects.filter(p=>p.id===alias||p.name===alias||p.aliases.includes(alias)||sources.has(p.id));
  if(!matches.length)throw new Error(`Unknown billing project: ${alias}`);if(matches.length>1)throw new Error(`Ambiguous billing project: ${alias}`);return matches[0];
 }
 saveProject(value:BillingProject,expectedRevision?:number):BillingProject{
  const project=validateBillingProject(value);if(expectedRevision!==undefined&&(!Number.isSafeInteger(expectedRevision)||expectedRevision<0))throw new Error('Invalid expected billing revision');
  const own=!this.db.isTransaction;if(own)this.db.exec('BEGIN IMMEDIATE');
  try{
   const row=this.db.prepare('SELECT revision,payload FROM billing_projects WHERE id=?').get(project.id),current=row?JSON.parse(String(row.payload)) as BillingProject:null;
   if(current?(expectedRevision!==Number(row!.revision)):(expectedRevision!==undefined&&expectedRevision!==0))throw new Error('Billing project revision conflict; reload the project');
   if(current&&current.policies.some((p,index)=>canonical(p)!==canonical(project.policies[index])))throw new Error('Billing policies are immutable; append a new policy version');
   const existingIds=new Set(current?.policies.map(policy=>policy.id)||[]);
   project.policies=project.policies.map(policy=>!existingIds.has(policy.id)&&policy.countingMode===undefined?{...policy,countingMode:'minutes'}:policy);
   const saved={...project,revision:current?Number(row!.revision)+1:1};
   for(const policy of saved.policies){const existing=this.db.prepare('SELECT payload FROM billing_policies WHERE project_id=? AND id=?').get(saved.id,policy.id),payload=canonical(policy);if(existing&&existing.payload!==payload)throw new Error('Billing policy is immutable');this.db.prepare('INSERT OR IGNORE INTO billing_policies VALUES(?,?,?)').run(saved.id,policy.id,payload);}
   this.db.prepare('INSERT INTO billing_projects VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload').run(saved.id,saved.revision,canonical(saved));
   if(own)this.db.exec('COMMIT');return saved;
  }catch(error){if(own&&this.db.isTransaction)this.db.exec('ROLLBACK');throw error;}
 }
 saveReport(report:BillingReport):void{
  validateBillingReport(report);
  const payload=canonical(report),existing=this.db.prepare('SELECT payload FROM billing_reports WHERE id=?').get(report.reportId);
  if(existing&&existing.payload!==payload)throw new Error('Billing report is immutable');
  this.db.prepare('INSERT OR IGNORE INTO billing_reports VALUES(?,?,?)').run(report.reportId,report.projectId,payload);
  // A competing writer may have won the unique ID after our first read.
  if(this.db.prepare('SELECT payload FROM billing_reports WHERE id=?').get(report.reportId)?.payload!==payload)throw new Error('Billing report is immutable');
 }
 report(id:string):BillingReport|null{if(!this.has('billing_reports'))return null;const row=this.db.prepare('SELECT payload FROM billing_reports WHERE id=?').get(id);return row?JSON.parse(String(row.payload)) as BillingReport:null;}
}

/** Imported configuration is additive only: divergent revisions need explicit review. */
export function previewBillingArchive(db:DatabaseSync):{newBillingProjects:number;newBillingReports:number;billingConflicts:number}{
 const tables=['billing_projects','billing_policies','billing_reports'];
 const present=tables.filter(table=>db.prepare("SELECT 1 FROM archive.sqlite_master WHERE type='table' AND name=?").get(table));
 if(!present.length)return {newBillingProjects:0,newBillingReports:0,billingConflicts:0};
 if(present.length!==tables.length)throw new Error('Archive billing schema is incomplete');
 let newBillingProjects=0,newBillingReports=0,billingConflicts=0;
 const projects=new Map<string,BillingProject>();
 for(const row of db.prepare('SELECT id,revision,payload FROM archive.billing_projects').iterate()){
  const raw=JSON.parse(String(row.payload)),p=validateBillingProject(raw);
  if(p.id!==row.id||p.revision!==row.revision||canonical(raw)!==canonical(p))throw new Error('Archive billing project is invalid');
  projects.set(p.id,p);const current=db.prepare('SELECT revision,payload FROM main.billing_projects WHERE id=?').get(p.id);
  if(!current)newBillingProjects++;else if(current.revision!==row.revision||current.payload!==row.payload)billingConflicts++;
 }
 const policies=new Set<string>();
 for(const row of db.prepare('SELECT project_id,id,payload FROM archive.billing_policies').iterate()){
  const project=projects.get(String(row.project_id)),policy=project?.policies.find(p=>p.id===row.id);
  if(!policy||canonical(policy)!==row.payload)throw new Error('Archive billing policy is invalid');
  policies.add(JSON.stringify([row.project_id,row.id]));
  const current=db.prepare('SELECT payload FROM main.billing_policies WHERE project_id=? AND id=?').get(row.project_id!,row.id!);
  if(current&&current.payload!==row.payload)billingConflicts++;
 }
 for(const project of projects.values())for(const policy of project.policies)if(!policies.has(JSON.stringify([project.id,policy.id])))throw new Error('Archive billing policy history is incomplete');
 for(const row of db.prepare('SELECT id,project_id,payload FROM archive.billing_reports').iterate()){
  const report=JSON.parse(String(row.payload)) as BillingReport;
  validateBillingReport(report);
  if(report.reportId!==row.id||report.projectId!==row.project_id||canonical(report)!==row.payload)throw new Error('Archive billing report is invalid');
  const current=db.prepare('SELECT project_id,payload FROM main.billing_reports WHERE id=?').get(row.id!);
  if(!current)newBillingReports++;else if(current.project_id!==row.project_id||current.payload!==row.payload)billingConflicts++;
 }
 return {newBillingProjects,newBillingReports,billingConflicts};
}
export function importBillingArchive(db:DatabaseSync):void{
 if(!db.prepare("SELECT 1 FROM archive.sqlite_master WHERE type='table' AND name='billing_projects'").get())return;
 if(previewBillingArchive(db).billingConflicts)throw new Error('Archive conflicts with billing configuration or saved reports; no data was changed');
 db.exec('INSERT OR IGNORE INTO main.billing_projects SELECT id,revision,payload FROM archive.billing_projects; INSERT OR IGNORE INTO main.billing_policies SELECT project_id,id,payload FROM archive.billing_policies; INSERT OR IGNORE INTO main.billing_reports SELECT id,project_id,payload FROM archive.billing_reports');
}
