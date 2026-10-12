import {existsSync,readFileSync,writeFileSync,mkdirSync,readdirSync,lstatSync,copyFileSync,renameSync,chmodSync,accessSync,constants} from 'node:fs';
import {homedir} from 'node:os';import {join,dirname,resolve} from 'node:path';import {fileURLToPath} from 'node:url';import {createHash,randomUUID} from 'node:crypto';import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {prepareConfig,applyConfig,restoreConfig,hookEvents,type Manifest} from './hook-config.ts';
export type HookProvider='claude'|'codex';
export interface HookTarget{id:string;provider:HookProvider;label:string;path:string;state:'not-installed'|'installed'|'needs-update'|'error';lastEvent:number|null;error:string|null;}
export interface HookInstallationStatus {setupSeen:boolean;runtimeVersion:string;runtimeReady:boolean;targets:HookTarget[];legacyPaths:string[];migrationError:string|null;}
interface Options {home?:string;env?:NodeJS.ProcessEnv;}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex').slice(0,16);
const quote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";
const files=['hook-runner.ts','hooks.ts','events.ts','store.ts','orca.ts'];
const source=dirname(fileURLToPath(import.meta.url));
const runtimeVersion=hash(process.version+files.map(f=>readFileSync(join(source,f),'utf8')).join('\n'));
function privateWrite(path:string,text:string){mkdirSync(dirname(path),{recursive:true,mode:0o700});if(existsSync(path)&&lstatSync(path).isSymbolicLink())throw new Error('symlink state refused');const temp=path+'.'+randomUUID()+'.tmp';writeFileSync(temp,text,{mode:0o600,flag:'wx'});renameSync(temp,path);}
export class HookInstallation{
 private output:string;private home:string;private env:NodeJS.ProcessEnv;private runtime:string;private stateRoot:string;private migrationError:string|null=null;private busy=false;private installErrors=new Map<string,string>();
 constructor(output:string,options:Options={}){this.output=resolve(output);this.home=options.home||homedir();this.env=options.env||process.env;this.stateRoot=join(this.home,'Library/Application Support/studio.ezyo.agenttime');this.runtime=join(this.stateRoot,'hook-runtime',runtimeVersion);}
 private ledgerPath(id:string){return join(this.stateRoot,'hook-installations',id,'managed.json');}
 private commands(id:string):string[]{const p=this.ledgerPath(id);if(!existsSync(p))return [];const value=JSON.parse(readFileSync(p,'utf8'));if(!Array.isArray(value.commands)||!value.commands.every((v:unknown)=>typeof v==='string'))throw new Error('Invalid managed hook record');return value.commands;}
 private targets(){
  const targets:Array<{provider:HookProvider;label:string;path:string}>=[],seen=new Set<string>();
  const add=(provider:HookProvider,label:string,folder:string)=>{const path=join(resolve(folder),provider==='claude'?'settings.json':'hooks.json');if(!seen.has(path)){seen.add(path);targets.push({provider,label,path});}};
  add('claude','Claude · user',join(this.home,'.claude'));add('codex','Codex · user',join(this.home,'.codex'));
  if(this.env.CLAUDE_CONFIG_DIR)add('claude','Claude · active config',this.env.CLAUDE_CONFIG_DIR);
  if(this.env.CODEX_HOME)add('codex','Codex · active config',this.env.CODEX_HOME);
  const base=join(this.home,'Library/Application Support/orca');
  for(const provider of ['claude','codex'] as const){
   const folder=join(base,provider+'-accounts');let index=0;
   for(const entry of existsSync(folder)?readdirSync(folder,{withFileTypes:true}):[]){if(!entry.isDirectory())continue;
    const root=join(folder,entry.name);index++;
    if(provider==='codex'){if(existsSync(join(root,'home')))add(provider,`Codex · Orca account ${index}`,join(root,'home'));}
    else for(const config of [root,join(root,'home')])if(existsSync(join(config,'settings.json'))||existsSync(join(config,'projects')))add(provider,`Claude · Orca account ${index}`,config);
   }
  }
  return targets.map(t=>({...t,id:hash(t.path)}));
 }
 private command(provider:HookProvider,id:string){return [join(this.runtime,'node'),join(this.runtime,'hook-runner.ts'),'--provider',provider,'--spool',join(this.output,'spool'),'--installation-id',id,'--runtime-version',runtimeVersion].map(quote).join(' ');}
 private ready(){try{accessSync(join(this.runtime,'node'),constants.X_OK);return files.every(f=>readFileSync(join(this.runtime,f),'utf8')===readFileSync(join(source,f),'utf8'));}catch{return false;}}
 private installRuntime(){
  const parent=dirname(this.runtime);if(existsSync(parent)&&lstatSync(parent).isSymbolicLink())throw new Error('symlink runtime refused');
  mkdirSync(parent,{recursive:true,mode:0o700});
  if(!this.ready()){
   if(existsSync(this.runtime)&&lstatSync(this.runtime).isSymbolicLink())throw new Error('symlink runtime refused');
   const temp=join(parent,'.'+runtimeVersion+'-'+randomUUID());mkdirSync(temp,{mode:0o700});
   copyFileSync(process.execPath,join(temp,'node'));chmodSync(join(temp,'node'),0o700);
   for(const f of files)copyFileSync(join(source,f),join(temp,f));writeFileSync(join(temp,'package.json'),'{"type":"module"}\n',{mode:0o600});
   if(existsSync(this.runtime))renameSync(this.runtime,this.runtime+'-replaced-'+randomUUID());renameSync(temp,this.runtime);
  }
  const check=JSON.parse(execFileSync(join(this.runtime,'node'),[join(this.runtime,'hook-runner.ts'),'--self-test'],{encoding:'utf8',timeout:5000,maxBuffer:4096}));if(check.ok!==true||check.node!==process.version)throw new Error('Hook runtime verification failed');
 }
 verify(){
  if(this.ready()){const check=JSON.parse(execFileSync(join(this.runtime,'node'),[join(this.runtime,'hook-runner.ts'),'--self-test'],{encoding:'utf8',timeout:5000,maxBuffer:4096}));if(check.ok!==true||check.node!==process.version)throw new Error('Installed hook runtime verification failed');}
  return this.status();
 }
 private legacy(provider?:HookProvider){
  const found:Array<{path:string;manifest:Manifest;file:string}>=[];
  for(const p of ['claude','codex'] as const){if(provider&&provider!==p)continue;const file=join(this.output,`${p}-hook-manifest.json`);if(!existsSync(file))continue;
   const manifest:Manifest=JSON.parse(readFileSync(file,'utf8'));if(!manifest.path||!manifest.entries||!existsSync(manifest.path))continue;
   // Only migrate the project configs recorded by the existing reversible installer.
   const suffix=p==='claude'?'.claude/settings.local.json':'.codex/hooks.json';if(!manifest.path.endsWith(suffix))continue;
   const config=JSON.parse(readFileSync(manifest.path,'utf8'));
   if(Object.entries(manifest.entries).some(([event,entry])=>(config.hooks?.[event]||[]).some((v:unknown)=>JSON.stringify(v)===JSON.stringify(entry))))found.push({path:manifest.path,manifest,file});
  }return found;
 }
 status():HookInstallationStatus{
  let lastEvents:Map<string,number>=new Map();
  try{const db=new DatabaseSync(join(this.output,'events.sqlite'),{readOnly:true});try{for(const row of db.prepare("SELECT json_extract(payload,'$.runtimeId') runtime,MAX(observed_at) at FROM events WHERE json_extract(payload,'$.source')='hook' GROUP BY 1").all() as Array<{runtime:string;at:number}>)lastEvents.set(row.runtime,row.at);}finally{db.close();}}catch{}
  const ready=this.ready(),targets=this.targets().map(t=>{
   let state:HookTarget['state']='not-installed',error:string|null=null;
   try{
    const command=this.command(t.provider,t.id),desired=prepareConfig(t.path,t.provider,command,hookEvents(t.provider),[...this.commands(t.id),command]);
    if(desired.existed){const current=JSON.parse(desired.original);const all=Object.values(current.hooks||{}).flatMap((groups:any)=>groups.flatMap((group:any)=>group.hooks));
     const managed=all.filter((h:any)=>[...this.commands(t.id),command].includes(h.command));
     if(managed.length)state=ready&&JSON.stringify(current)===JSON.stringify(JSON.parse(desired.updated))?'installed':'needs-update';
    }
   }catch(e){state='error';error=String(e);}
   if(this.installErrors.has(t.id)){state='error';error=this.installErrors.get(t.id)!;}
   return {...t,state,error,lastEvent:lastEvents.get(`${t.id}/${runtimeVersion}`)||null};
  });
  let legacyPaths:string[]=[];try{legacyPaths=this.legacy().map(l=>l.path);}catch(e){this.migrationError=String(e);}
  return {setupSeen:existsSync(join(this.stateRoot,'hook-setup.json')),runtimeVersion,runtimeReady:ready,targets,legacyPaths,migrationError:this.migrationError};
 }
 dismiss(){privateWrite(join(this.stateRoot,'hook-setup.json'),JSON.stringify({version:1,seenAt:Date.now()})+'\n');return this.status();}
 async install(provider:HookProvider){
  if(!['claude','codex'].includes(provider))throw new Error('Invalid provider');if(this.busy)throw new Error('Hook installation is already running');this.busy=true;
  try{
   this.installErrors.clear();this.installRuntime();
   for(const t of this.targets().filter(t=>t.provider===provider)){
    try{
     const command=this.command(provider,t.id),owned=this.commands(t.id),manifest=prepareConfig(t.path,provider,command,hookEvents(provider),[...owned,command]);
     const backup=join(this.stateRoot,'hook-installations',t.id,'original.json');if(!existsSync(backup))privateWrite(backup,JSON.stringify(manifest,null,2)+'\n');
     // Record ownership before applying, so an interrupted install remains repairable.
     privateWrite(this.ledgerPath(t.id),JSON.stringify({path:t.path,commands:[...new Set([...owned,command])]},null,2)+'\n');applyConfig(manifest);
    }catch(e){this.installErrors.set(t.id,String(e));}
   }
   if(this.status().targets.filter(t=>t.provider===provider).every(t=>t.state==='installed')){
    this.migrationError=null;
    try{for(const legacy of this.legacy(provider)){restoreConfig(legacy.manifest);renameSync(legacy.file,legacy.file+'.migrated');}}catch(e){this.migrationError=String(e);}
   }
   return this.status();
  }finally{this.busy=false;}
 }
}
