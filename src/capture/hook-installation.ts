import {existsSync,readFileSync,writeFileSync,mkdirSync,readdirSync,lstatSync,copyFileSync,renameSync,chmodSync,accessSync,constants,rmSync} from 'node:fs';
import {homedir} from 'node:os';import {join,dirname,resolve,basename} from 'node:path';import {fileURLToPath} from 'node:url';import {createHash,randomUUID} from 'node:crypto';import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {isDeepStrictEqual} from 'node:util';
import {prepareConfig,applyConfig,restoreConfig,hookEvents,type Manifest} from './hook-config.ts';
import {agents,agentById} from './sources/agent-registry.ts';
import {pruneHookRuntimes} from './hook-runtime-prune.ts';
export type HookProvider=string;
export interface HookTarget{id:string;provider:HookProvider;label:string;path:string;state:'not-installed'|'installed'|'needs-update'|'error';lastEvent:number|null;error:string|null;reason?:string|null;}
export interface HookInstallationStatus {setupSeen:boolean;runtimeVersion:string;runtimeReady:boolean;agents:Array<{id:string;name:string;setting:string;usageSetting:string;trustNote?:string}>;targets:HookTarget[];legacyPaths:string[];migrationError:string|null;}
export interface TrackingCleanupPreview {configurations:string[];helpers:string[];errors:string[];}
export interface TrackingCleanupResult {removedConfigurations:string[];removedHelpers:string[];errors:string[];}
interface Options {home?:string;env?:NodeJS.ProcessEnv;}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex').slice(0,16);
const quote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";
const source=dirname(fileURLToPath(import.meta.url));
const files=['hook-runner.ts','hooks.ts','events.ts','store.ts','observation-retention.ts','orca.ts',...readdirSync(join(source,'sources')).filter(f=>f.endsWith('.agent.ts')||f==='agent-registry.ts'||f==='types.ts').map(f=>join('sources',f))];
const runtimeVersion=hash(process.version+files.map(f=>readFileSync(join(source,f),'utf8')).join('\n'));
const launcher=`#!/bin/sh
root=\${0%/*}
IFS= read -r version < "$root/current" || exit 0
case "$version" in
  ????????????????) case "$version" in *[!0-9a-f]*) exit 0;; esac ;;
  *) exit 0 ;;
esac
exec "$root/$version/node" "$root/$version/hook-runner.ts" "$@" --runtime-version "$version"
`;
function privateWrite(path:string,text:string){mkdirSync(dirname(path),{recursive:true,mode:0o700});if(existsSync(path)&&lstatSync(path).isSymbolicLink())throw new Error('symlink state refused');const temp=path+'.'+randomUUID()+'.tmp';writeFileSync(temp,text,{mode:0o600,flag:'wx'});renameSync(temp,path);}
export class HookInstallation{
 private output:string;private home:string;private env:NodeJS.ProcessEnv;private runtime:string;private stateRoot:string;private migrationError:string|null=null;private busy=false;private installErrors=new Map<string,string>();
 constructor(output:string,options:Options={}){this.output=resolve(output);this.home=options.home||homedir();this.env=options.env||process.env;this.stateRoot=join(this.home,'Library/Application Support/studio.ezyo.agenttime');this.runtime=join(this.stateRoot,'hook-runtime',runtimeVersion);const records=join(this.stateRoot,'hook-installations');const installed=existsSync(records)&&readdirSync(records,{withFileTypes:true}).some(entry=>entry.isDirectory()&&existsSync(this.ledgerPath(entry.name)));if(installed)try{this.installRuntime();}catch{/* Status reports a runtime that needs repair without blocking capture startup. */}}
 private ledgerPath(id:string){return join(this.stateRoot,'hook-installations',id,'managed.json');}
 private commands(id:string):string[]{const p=this.ledgerPath(id);if(!existsSync(p))return [];const value=JSON.parse(readFileSync(p,'utf8'));if(!Array.isArray(value.commands)||!value.commands.every((v:unknown)=>typeof v==='string'))throw new Error('Invalid managed hook record');return value.commands;}
 private recognizedCommands(provider:HookProvider,targets:Array<{provider:HookProvider;id:string}>):string[]{
  const recognized=new Set<string>();
  for(const target of targets.filter(t=>t.provider===provider)){
   try{for(const command of this.commands(target.id))recognized.add(command);}catch{/* The owning target reports its invalid record separately. */}
   recognized.add(this.command(provider,target.id));
  }
  return [...recognized];
 }
 private targets(){
  const targets:Array<{provider:HookProvider;label:string;path:string}>=[],seen=new Set<string>();
  const add=(provider:HookProvider,label:string,folder:string)=>{const agent=agentById.get(provider);if(!agent)return;const path=join(resolve(folder),agent.configFile);if(!seen.has(path)){seen.add(path);targets.push({provider,label,path});}};
  for(const agent of agents){add(agent.id,`${agent.name} · user`,join(this.home,agent.configDirectory));if(this.env[agent.configEnv])add(agent.id,`${agent.name} · active config`,this.env[agent.configEnv]!);}
  const base=join(this.home,'Library/Application Support/orca');
  for(const agent of agents){
   const folder=join(base,agent.id+'-accounts');let index=0;
   for(const entry of existsSync(folder)?readdirSync(folder,{withFileTypes:true}):[]){if(!entry.isDirectory())continue;
    const root=join(folder,entry.name);index++;
    for(const config of agent.discoverAccount(root))add(agent.id,`${agent.name} · Orca account ${index}`,config);
   }
  }
  return targets.map(t=>({...t,id:hash(t.path)}));
 }
 private command(provider:HookProvider,id:string){return ['/bin/sh',join(dirname(this.runtime),'launch.sh'),'--provider',provider,'--spool',join(this.output,'spool'),'--installation-id',id].map(quote).join(' ');}
 private ready(){try{const parent=dirname(this.runtime),node=join(this.runtime,'node');if(!lstatSync(node).isFile()||!lstatSync(join(parent,'launch.sh')).isFile()||!lstatSync(join(parent,'current')).isFile())return false;accessSync(node,constants.X_OK);return readFileSync(join(parent,'launch.sh'),'utf8')===launcher&&readFileSync(join(parent,'current'),'utf8')===runtimeVersion+'\n'&&files.every(f=>lstatSync(join(this.runtime,f)).isFile()&&readFileSync(join(this.runtime,f),'utf8')===readFileSync(join(source,f),'utf8'));}catch{return false;}}
 private installRuntime(){
  const parent=dirname(this.runtime);if(existsSync(parent)&&lstatSync(parent).isSymbolicLink())throw new Error('symlink runtime refused');
  mkdirSync(parent,{recursive:true,mode:0o700});
  if(existsSync(this.runtime)&&lstatSync(this.runtime).isSymbolicLink())throw new Error('symlink runtime refused');
  const bundleReady=()=>{try{const node=join(this.runtime,'node');if(!lstatSync(node).isFile())return false;accessSync(node,constants.X_OK);if(!files.every(f=>lstatSync(join(this.runtime,f)).isFile()&&readFileSync(join(this.runtime,f),'utf8')===readFileSync(join(source,f),'utf8')))return false;const check=JSON.parse(execFileSync(node,[join(this.runtime,'hook-runner.ts'),'--self-test'],{encoding:'utf8',timeout:5000,maxBuffer:4096}));return check.ok===true&&check.node===process.version;}catch{return false;}};
  if(!bundleReady()){
   const temp=join(parent,'.'+runtimeVersion+'-'+randomUUID());mkdirSync(temp,{mode:0o700});
   copyFileSync(process.execPath,join(temp,'node'));chmodSync(join(temp,'node'),0o700);
   mkdirSync(join(temp,'sources'),{mode:0o700});for(const f of files)copyFileSync(join(source,f),join(temp,f));writeFileSync(join(temp,'package.json'),'{"type":"module"}\n',{mode:0o600});
   if(existsSync(this.runtime))renameSync(this.runtime,this.runtime+'-replaced-'+randomUUID());renameSync(temp,this.runtime);
  }
  const check=JSON.parse(execFileSync(join(this.runtime,'node'),[join(this.runtime,'hook-runner.ts'),'--self-test'],{encoding:'utf8',timeout:5000,maxBuffer:4096}));if(check.ok!==true||check.node!==process.version)throw new Error('Hook runtime verification failed');
  const launchPath=join(parent,'launch.sh'),currentPath=join(parent,'current');
  for(const path of [launchPath,currentPath])if(existsSync(path)&&lstatSync(path).isSymbolicLink())throw new Error('symlink hook launcher refused');
  if(!existsSync(launchPath)||readFileSync(launchPath,'utf8')!==launcher)privateWrite(launchPath,launcher);
  if(!existsSync(currentPath)||readFileSync(currentPath,'utf8')!==runtimeVersion+'\n')privateWrite(currentPath,runtimeVersion+'\n');
  const launched=JSON.parse(execFileSync('/bin/sh',[launchPath,'--self-test'],{encoding:'utf8',timeout:5000,maxBuffer:4096}));if(launched.ok!==true||launched.node!==process.version)throw new Error('Hook launcher verification failed');
  void pruneHookRuntimes(parent,runtimeVersion).catch(()=>{});
  // Newly replaced copies get a grace period for hooks already in flight.
  // Recheck after that period even if Agent Time stays open for days.
  setTimeout(()=>{
   try{if(readFileSync(currentPath,'utf8')===runtimeVersion+'\n')void pruneHookRuntimes(parent,runtimeVersion).catch(()=>{});}catch{/* A changed launcher is left alone. */}
  },65*60*1000).unref();
 }
 verify(){
  if(this.ready()){const check=JSON.parse(execFileSync('/bin/sh',[join(dirname(this.runtime),'launch.sh'),'--self-test'],{encoding:'utf8',timeout:5000,maxBuffer:4096}));if(check.ok!==true||check.node!==process.version)throw new Error('Installed hook runtime verification failed');}
  return this.status();
 }
 private legacy(provider?:HookProvider){
  const found:Array<{path:string;manifest:Manifest;file:string}>=[];
  for(const agent of agents){const p=agent.id;if(provider&&provider!==p||!agent.legacyConfigSuffix)continue;const file=join(this.output,`${p}-hook-manifest.json`);if(!existsSync(file))continue;
   const manifest:Manifest=JSON.parse(readFileSync(file,'utf8'));if(!manifest.path||!manifest.entries||!existsSync(manifest.path))continue;
   // Only migrate the project configs recorded by the existing reversible installer.
   const suffix=agent.legacyConfigSuffix;if(!manifest.path.endsWith(suffix))continue;
   const config=JSON.parse(readFileSync(manifest.path,'utf8'));
   if(Object.entries(manifest.entries).some(([event,entry])=>(config.hooks?.[event]||[]).some((v:unknown)=>JSON.stringify(v)===JSON.stringify(entry))))found.push({path:manifest.path,manifest,file});
  }return found;
 }
 status():HookInstallationStatus{
  let lastEvents:Map<string,number>=new Map();
  try{const db=new DatabaseSync(join(this.output,'events.sqlite'),{readOnly:true});try{for(const row of db.prepare("SELECT json_extract(payload,'$.runtimeId') runtime,MAX(observed_at) at FROM events WHERE json_extract(payload,'$.source')='hook' GROUP BY 1").all() as Array<{runtime:string;at:number}>)lastEvents.set(row.runtime,row.at);}finally{db.close();}}catch{}
  const ready=this.ready(),discovered=this.targets(),targets=discovered.map(t=>{
   let state:HookTarget['state']='not-installed',error:string|null=null,reason:string|null=null;
   let matchedId:string|undefined;
   try{
    const command=this.command(t.provider,t.id),owned=this.commands(t.id);
    // Orca can copy the user hook config into an account home. Its command is
    // still ours, even though its installation ID names the original path.
    const candidates=owned.length?discovered.filter(other=>other.provider===t.provider):[t];
    const recognized=this.recognizedCommands(t.provider,discovered);
    const desired=prepareConfig(t.path,t.provider,command,hookEvents(t.provider),recognized);
    if(desired.existed){const current=JSON.parse(desired.original);const all=Object.values(current.hooks||{}).flatMap((groups:any)=>groups.flatMap((group:any)=>group.hooks));
     const managed=all.filter((h:any)=>recognized.includes(h.command));
     if(managed.length){
      state='needs-update';reason=ready?'Managed hook configuration changed':'Hook runtime needs repair';
      if(ready)for(const candidate of candidates){
       const candidateCommand=this.command(candidate.provider,candidate.id);
       const equivalent=prepareConfig(t.path,t.provider,candidateCommand,hookEvents(t.provider),recognized);
       if(isDeepStrictEqual(current,JSON.parse(equivalent.updated))){state='installed';reason=null;matchedId=candidate.id;break;}
      }
     }
    }
    if(state==='not-installed'&&owned.length){state='needs-update';reason='Previously managed hook is missing';}
    if(state==='not-installed')reason='No Agent Time hook is installed';
   }catch(e){state='error';error=String(e);reason='Configuration could not be read safely';}
   if(this.installErrors.has(t.id)){state='error';error=this.installErrors.get(t.id)!;reason='Last repair failed';}
   return {...t,state,error,reason,lastEvent:lastEvents.get(`${matchedId||t.id}/${runtimeVersion}`)||null};
  });
  let legacyPaths:string[]=[];try{legacyPaths=this.legacy().map(l=>l.path);}catch(e){this.migrationError=String(e);}
  return {setupSeen:existsSync(join(this.stateRoot,'hook-setup.json')),runtimeVersion,runtimeReady:ready,agents:agents.map(({id,name,setting,usageSetting,trustNote})=>({id,name,setting,usageSetting,trustNote})),targets,legacyPaths,migrationError:this.migrationError};
 }
 dismiss(){privateWrite(join(this.stateRoot,'hook-setup.json'),JSON.stringify({version:1,seenAt:Date.now()})+'\n');return this.status();}
 private cleanupPlan(){
  const manifests:Manifest[]=[],helpers:string[]=[],errors:string[]=[];
  const records=join(this.stateRoot,'hook-installations');
  const managed:Array<{path:string;provider:HookProvider}>=[];
  const commands:Record<HookProvider,string[]>=Object.fromEntries(agents.map(agent=>[agent.id,[]]));
  try{if(existsSync(records)){
   if(lstatSync(records).isSymbolicLink())throw new Error('symlink ownership folder refused');
   for(const entry of readdirSync(records,{withFileTypes:true})){
    try{
     if(!entry.isDirectory())throw new Error('Unexpected ownership record');
     const file=this.ledgerPath(entry.name);if(!existsSync(file))continue;
     if(lstatSync(file).isSymbolicLink())throw new Error('symlink ownership record refused');
     const record=JSON.parse(readFileSync(file,'utf8'));
     if(typeof record.path!=='string'||hash(record.path)!==entry.name)throw new Error('Invalid managed path');
     if(!Array.isArray(record.commands)||!record.commands.every((value:unknown)=>typeof value==='string'))throw new Error('Invalid managed hook record');
     const candidates=agents.filter(agent=>agent.configFile===basename(record.path));
     const ownedProviders=new Set(record.commands.map((command:string)=>command.match(/'--provider'\s+'([a-z0-9-]+)'/)?.[1]).filter((value:unknown):value is string=>typeof value==='string'));
     const recorded=typeof record.provider==='string'?record.provider:ownedProviders.size===1?[...ownedProviders][0]:undefined;
     const provider=recorded&&agentById.get(recorded)?.configFile===basename(record.path)?recorded:candidates.length===1?candidates[0].id:undefined;
     if(!provider)throw new Error('Unknown managed provider');
     managed.push({path:record.path,provider});commands[provider].push(...record.commands);
    }catch(e){errors.push(`${entry.name}: ${String(e)}`);}
   }
  }}catch(e){errors.push(String(e));}
  // Orca may have copied an owned command from one provider config to another.
  for(const record of managed){try{
   if(!existsSync(record.path))continue;
   const manifest=prepareConfig(record.path,record.provider,'',[],commands[record.provider]);
   if(JSON.stringify(JSON.parse(manifest.original))!==JSON.stringify(JSON.parse(manifest.updated)))manifests.push(manifest);
  }catch(e){errors.push(`${record.path}: ${String(e)}`);}}
  // Legacy project installers recorded exact command ownership as well.
  for(const agent of agents.filter(agent=>agent.legacyConfigSuffix)){const provider=agent.id;try{
   const file=join(this.output,`${provider}-hook-manifest.json`);
   if(!existsSync(file))continue;
   if(lstatSync(file).isSymbolicLink())throw new Error('symlink legacy record refused');
   const manifest:Manifest=JSON.parse(readFileSync(file,'utf8'));
   if(typeof manifest.path!=='string'||!manifest.path.endsWith(agent.legacyConfigSuffix!)||!manifest.entries)throw new Error('Invalid legacy record');
   if(!existsSync(manifest.path))continue;
   for(const legacy of [{path:manifest.path,manifest}]){
    const commands=Object.values(legacy.manifest.entries).flatMap((entry:any)=>entry.hooks?.map((handler:any)=>handler.command)||[]);
    if(!commands.length||!commands.every((c:unknown)=>typeof c==='string'))throw new Error('Invalid legacy ownership');
    const desired=prepareConfig(legacy.path,provider,'',[],commands);
    if(JSON.stringify(JSON.parse(desired.original))!==JSON.stringify(JSON.parse(desired.updated)))manifests.push(desired);
   }
  }catch(e){errors.push(`${provider} project hooks: ${String(e)}`);}}
  // This folder is exclusively our generated runtime. Unknown contents are retained.
  const root=join(this.stateRoot,'hook-runtime'),allowed=new Set([...files.filter(f=>!f.includes('/')),'sources','node','package.json']);
  try{if(existsSync(root)){
   if(lstatSync(root).isSymbolicLink())throw new Error('symlink runtime folder refused');
   for(const entry of readdirSync(root,{withFileTypes:true})){
    const path=join(root,entry.name);
    if(entry.isFile()&&['launch.sh','current'].includes(entry.name)){helpers.push(path);continue;}
    if(!entry.isDirectory()||!/^\.?[a-f0-9]{16}(?:-replaced-[a-f0-9-]+|-[a-f0-9-]+)?$/.test(entry.name))throw new Error(`Unrecognized runtime retained: ${path}`);
    if(readdirSync(path,{withFileTypes:true}).some(f=>f.name==='sources'? !f.isDirectory()||readdirSync(join(path,'sources'),{withFileTypes:true}).some(child=>!child.isFile()||!files.includes(join('sources',child.name))):!f.isFile()||!allowed.has(f.name)))throw new Error(`Unexpected runtime contents retained: ${path}`);
    helpers.push(path);
   }
  }}catch(e){errors.push(String(e));}
  return {manifests,helpers,errors};
 }
 cleanupPreview():TrackingCleanupPreview {const plan=this.cleanupPlan();return {configurations:plan.manifests.map(m=>m.path),helpers:plan.helpers,errors:plan.errors};}
 cleanup():TrackingCleanupResult {
  if(this.busy)throw new Error('Hook installation is already running');this.busy=true;
  const result:TrackingCleanupResult={removedConfigurations:[],removedHelpers:[],errors:[]};
  try{
   const plan=this.cleanupPlan();result.errors.push(...plan.errors);
   for(const manifest of plan.manifests){try{applyConfig(manifest);result.removedConfigurations.push(manifest.path);}catch(e){result.errors.push(`${manifest.path}: ${String(e)}`);}}
   // A remaining hook must never lose its executable after a partial cleanup.
   if(!result.errors.length)for(const helper of plan.helpers){try{rmSync(helper,{recursive:true});result.removedHelpers.push(helper);}catch(e){result.errors.push(`${helper}: ${String(e)}`);}}
   if(!result.errors.length){
    const records=join(this.stateRoot,'hook-installations');
    for(const entry of existsSync(records)?readdirSync(records,{withFileTypes:true}):[]){
     if(!entry.isDirectory())continue;
     const ledger=this.ledgerPath(entry.name);
     if(existsSync(ledger))try{rmSync(ledger);}catch(e){result.errors.push(`${ledger}: ${String(e)}`);}
    }
   }
   this.installErrors.clear();return result;
  }finally{this.busy=false;}
 }
 async install(provider:HookProvider,targetIds?:string[]){
  if(!agentById.has(provider))throw new Error('Invalid provider');if(this.busy)throw new Error('Hook installation is already running');this.busy=true;
  try{
   this.installErrors.clear();this.installRuntime();
   const allProviderTargets=this.targets().filter(t=>t.provider===provider);
   if(targetIds!==undefined&&(!Array.isArray(targetIds)||!targetIds.length||targetIds.length>100||targetIds.some(id=>typeof id!=='string'||!allProviderTargets.some(t=>t.id===id))))throw new Error('Invalid hook target selection');
   const selected=new Set(targetIds||allProviderTargets.map(t=>t.id));
   const states=new Map(this.status().targets.map(t=>[t.id,t.state]));
   const providerTargets=allProviderTargets.filter(t=>selected.has(t.id)&&states.get(t.id)!=='installed');
   for(const t of providerTargets){
    try{
     const command=this.command(provider,t.id),owned=this.commands(t.id);
     const recognized=this.recognizedCommands(provider,allProviderTargets);
     const manifest=prepareConfig(t.path,provider,command,hookEvents(provider),recognized);
     const backup=join(this.stateRoot,'hook-installations',t.id,'original.json');if(!existsSync(backup))privateWrite(backup,JSON.stringify(manifest,null,2)+'\n');
     // Record ownership before applying, so an interrupted install remains repairable.
     privateWrite(this.ledgerPath(t.id),JSON.stringify({path:t.path,provider,commands:[...new Set([...owned,command])]},null,2)+'\n');applyConfig(manifest);
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
