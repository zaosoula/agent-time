import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {existsSync,readFileSync,writeFileSync,renameSync,readdirSync,statSync} from 'node:fs';
import {basename,isAbsolute,join,resolve,sep} from 'node:path';
import {homedir} from 'node:os';

export interface WebsiteRule {pattern:string;projectPath:string;}
export interface KnownWorkspace {projectPath:string;workspacePath:string;workspaceId:string;}
export interface WebsiteSuggestion {projectPath:string;source:string;detail:string;}
export interface WebsiteResolution {
 key:string;origin:string;url:string;observedAt:number;
 projectPath?:string;workspaceId?:string;source?:string;detail?:string;
 suggestions:WebsiteSuggestion[];
}
type Runner=(file:string,args:string[],timeout?:number)=>Promise<string|null>;
const defaultRunner:Runner=async(file,args,timeout=1800)=>{
 try{return (await promisify(execFile)(file,args,{timeout,maxBuffer:256_000})).stdout.trim();}catch{return null;}
};
const dockerBinary=()=>['/usr/local/bin/docker','/opt/homebrew/bin/docker','/Applications/Docker.app/Contents/Resources/bin/docker'].find(existsSync);
const inside=(path:string,root:string)=>path===root||path.startsWith(root+sep);
export function projectPathFromWorktree(path:string):string{
 const marker=`${sep}.orca${sep}workspaces${sep}`,index=path.indexOf(marker);
 return resolve(index>=0?path.slice(0,index):path);
}
export function websiteKey(raw:string,rules:WebsiteRule[]=[]):string|null{
 try{
  const url=new URL(raw);
  if(!['http:','https:'].includes(url.protocol))return null;
  const rule=matchingRule(url,rules);if(rule)return rule.pattern;
  const slug=githubPageSlug(url);
  return slug?`https://github.com/${slug}`:url.origin;
 }catch{return null;}
}
export function githubPageSlug(url:URL):string|null{
 if(!['github.com','www.github.com'].includes(url.hostname.toLowerCase()))return null;
 const parts=url.pathname.split('/').filter(Boolean);
 return parts.length>=2?`${parts[0].toLowerCase()}/${parts[1].replace(/\.git$/i,'').toLowerCase()}`:null;
}
export function githubRemoteSlug(raw:string):string|null{
 const value=raw.trim();
 const ssh=value.match(/^(?:ssh:\/\/)?git@github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
 if(ssh)return `${ssh[1].toLowerCase()}/${ssh[2].replace(/\.git$/i,'').toLowerCase()}`;
 try{const url=new URL(value);if(!['github.com','www.github.com'].includes(url.hostname.toLowerCase()))return null;const parts=url.pathname.split('/').filter(Boolean);return parts.length===2?`${parts[0].toLowerCase()}/${parts[1].replace(/\.git$/i,'').toLowerCase()}`:null;}catch{return null;}
}
export function normalizeRulePattern(raw:string):string{
 const url=new URL(raw.trim());
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('Rule must be an HTTP(S) origin or URL path prefix');
 const path=url.pathname.replace(/\/$/,'');
 return url.origin+(path&&path!=='/'?path:'');
}
export function matchingRule(url:URL,rules:WebsiteRule[]):WebsiteRule|undefined{
 return [...rules].filter(rule=>url.href===rule.pattern||url.href.startsWith(rule.pattern+'/')||url.href.startsWith(rule.pattern+'?')||url.href.startsWith(rule.pattern+'#')||rule.pattern===url.origin)
  .sort((a,b)=>b.pattern.length-a.pattern.length)[0];
}
function uniqueSuggestions(items:WebsiteSuggestion[]):WebsiteSuggestion[]{
 const seen=new Set<string>();return items.filter(item=>{const key=item.projectPath+':'+item.source;if(seen.has(key))return false;seen.add(key);return true;});
}
function localHost(host:string):boolean{
 if(host==='localhost'||host.endsWith('.localhost')||host==='127.0.0.1'||host==='[::1]'||host==='::1')return true;
 try{return readFileSync('/etc/hosts','utf8').split('\n').some(line=>{const parts=line.replace(/#.*/,'').trim().split(/\s+/);return ['127.0.0.1','::1'].includes(parts[0])&&parts.slice(1).includes(host);});}catch{return false;}
}
interface Listener {pid:number;name:string;address:string;}
// These host-wide helpers forward ports for many unrelated containers. Their cwd
// reflects where the helper started, not the project serving a published port.
const containerForwarder=/(?:OrbStack Helper|com\.docker\.backend|docker-proxy|vpnkit)/i;
function parseListeners(output:string):Listener[]{
 const listeners:Listener[]=[];let pid=0,name='';
 for(const line of output.split('\n')){
  if(line.startsWith('p'))pid=Number(line.slice(1));
  else if(line.startsWith('c'))name=line.slice(1);
  else if(line.startsWith('n')&&pid)listeners.push({pid,name,address:line.slice(1)});
 }
 return listeners;
}
function cloneDirectories():string[]{
 const roots=[join(homedir(),'Github'),join(homedir(),'Projects'),join(homedir(),'orca','projects')],found:string[]=[];let visited=0;
 function walk(path:string,depth:number){
  if(depth>3||visited++>400||!existsSync(path))return;
  if(existsSync(join(path,'.git'))){found.push(path);return;}
  try{for(const entry of readdirSync(path,{withFileTypes:true}))if(entry.isDirectory()&&!entry.name.startsWith('.')&&!['node_modules','target','dist','build'].includes(entry.name))walk(join(path,entry.name),depth+1);}catch{/* Unreadable directories are skipped. */}
 }
 for(const root of roots)walk(root,0);return found;
}

export class WebsiteResolver {
 private rulesPath:string;private savedRules:WebsiteRule[]=[];
 private remoteIndex:{at:number;paths:string;bySlug:Map<string,string[]>}|null=null;
 private cloneIndex:{at:number;paths:string[]}|null=null;
 private run:Runner;private dockerOverride?:string;
 constructor(output:string,run:Runner=defaultRunner,options:{dockerBinary?:string}={}){
  this.run=run;
  this.dockerOverride=options.dockerBinary;
  this.rulesPath=join(output,'website-rules.json');
  if(existsSync(this.rulesPath)){
   try{const parsed:unknown=JSON.parse(readFileSync(this.rulesPath,'utf8'));if(Array.isArray(parsed))this.savedRules=parsed.filter((r):r is WebsiteRule=>Boolean(r&&typeof r==='object'&&typeof r.pattern==='string'&&typeof r.projectPath==='string')).map(r=>({pattern:normalizeRulePattern(r.pattern),projectPath:projectPathFromWorktree(r.projectPath)}));}catch{/* Invalid rules are ignored, not overwritten. */}
  }
 }
 rules():WebsiteRule[]{return this.savedRules.map(rule=>({...rule}));}
 candidateProjects(known:KnownWorkspace[]):string[]{return [...new Set([...known.map(k=>k.projectPath),...this.savedRules.map(r=>r.projectPath)])].sort();}
 private clonePaths():string[]{if(this.cloneIndex&&Date.now()-this.cloneIndex.at<60_000)return this.cloneIndex.paths;const paths=cloneDirectories();this.cloneIndex={at:Date.now(),paths};return paths;}
 setRule(pattern:string,path:string):WebsiteRule[]{
  if(!isAbsolute(path))throw new Error('Choose an absolute project directory');
  const normalized=normalizeRulePattern(pattern),projectPath=projectPathFromWorktree(path);
  if(!existsSync(projectPath)||!statSync(projectPath).isDirectory())throw new Error('Choose an existing project directory');
  const next=[...this.savedRules.filter(r=>r.pattern!==normalized),{pattern:normalized,projectPath}].sort((a,b)=>a.pattern.localeCompare(b.pattern));
  this.save(next);return this.rules();
 }
 removeRule(pattern:string):WebsiteRule[]{const normalized=normalizeRulePattern(pattern);this.save(this.savedRules.filter(r=>r.pattern!==normalized));return this.rules();}
 private save(next:WebsiteRule[]){writeFileSync(this.rulesPath+'.tmp',JSON.stringify(next,null,2)+'\n',{mode:0o600});renameSync(this.rulesPath+'.tmp',this.rulesPath);this.savedRules=next;}
 private match(path:string,known:KnownWorkspace[],source:string,detail:string):Pick<WebsiteResolution,'projectPath'|'workspaceId'|'source'|'detail'>{
  const workspaces=known.filter(k=>inside(path,k.workspacePath)).sort((a,b)=>b.workspacePath.length-a.workspacePath.length);
  const selected=workspaces.length===1||workspaces[0]?.workspacePath.length>workspaces[1]?.workspacePath.length?workspaces[0]:undefined;
  const projects=known.filter(k=>inside(path,k.projectPath)).sort((a,b)=>b.projectPath.length-a.projectPath.length);
  const projectPath=selected?.projectPath||projects[0]?.projectPath||projectPathFromWorktree(path);
  return {projectPath,workspaceId:selected?.workspaceId||`web::${projectPath}`,source,detail};
 }
 private async remotes(known:KnownWorkspace[]):Promise<Map<string,string[]>>{
  const paths=[...new Set([...known.map(k=>k.projectPath),...this.clonePaths()])].sort();
  const signature=paths.join('\n');
  if(this.remoteIndex&&Date.now()-this.remoteIndex.at<300_000&&this.remoteIndex.paths===signature)return this.remoteIndex.bySlug;
  const bySlug=new Map<string,string[]>();
  for(const path of paths){
   const stdout=await this.run('/usr/bin/git',['-C',path,'config','--get-regexp','^remote\\..*\\.url$'],1200);
   for(const line of stdout?.split('\n')||[]){const raw=line.slice(line.indexOf(' ')+1),slug=githubRemoteSlug(raw);if(!slug)continue;const group=bySlug.get(slug)||[];if(!group.includes(path))group.push(path);bySlug.set(slug,group);}
  }
  this.remoteIndex={at:Date.now(),paths:signature,bySlug};return bySlug;
 }
 async repositoryProjects(slugs:string[],known:KnownWorkspace[]):Promise<Record<string,string[]>>{
  const remotes=await this.remotes(known),result:Record<string,string[]>={};
  for(const slug of slugs)result[slug]=remotes.get(slug)||[];
  return result;
 }
 private async processPath(pid:number,known:KnownWorkspace[]):Promise<{path:string;source:string;detail:string;auto:boolean}|null>{
  let current=pid;
  for(let depth=0;depth<7&&current>1;depth++){
   const [cwdInfo,command,parent]=await Promise.all([
    this.run('/usr/sbin/lsof',['-a','-p',String(current),'-d','cwd','-Fn'],1000),
    this.run('/bin/ps',['-p',String(current),'-o','command='],1000),
    this.run('/bin/ps',['-p',String(current),'-o','ppid='],1000),
   ]);
   const path=cwdInfo?.split('\n').find(line=>line.startsWith('n'))?.slice(1);
   if(containerForwarder.test(command||''))return null;
   if(path&&existsSync(path)){
    const proxy=/\b(?:caddy|nginx|traefik|ssh|kubectl|cloudflared|ngrok)\b/i.test(command||'');
    const orca=known.filter(k=>inside(path,k.workspacePath)).sort((a,b)=>b.workspacePath.length-a.workspacePath.length);
    if(orca.length&&(!orca[1]||orca[0].workspacePath.length>orca[1].workspacePath.length))return {path,source:proxy?'proxy_process':'orca_process',detail:proxy?'Proxy or tunnel launched from an Orca worktree':`Process ${pid} belongs to an Orca worktree`,auto:!proxy};
    if(depth===0&&!proxy){
     const root=await this.run('/usr/bin/git',['-C',path,'rev-parse','--show-toplevel'],1000);
     if(root&&existsSync(root))return {path:root,source:'port_process',detail:`Port is owned by process ${pid}`,auto:true};
    }
   }
   const next=Number(parent);if(!Number.isInteger(next)||next<=1||next===current)break;current=next;
  }
  return null;
 }
 private async portOwner(port:number,known:KnownWorkspace[]):Promise<{match?:Pick<WebsiteResolution,'projectPath'|'workspaceId'|'source'|'detail'>;listeners:Listener[];suggestions:WebsiteSuggestion[]}>{
  const stdout=await this.run('/usr/sbin/lsof',['-nP','-a',`-iTCP:${port}`,'-sTCP:LISTEN','-Fpcn'],1200);
  const listeners=parseListeners(stdout||'').filter(l=>l.address.endsWith(':'+port));
  const pids=[...new Set(listeners.map(l=>l.pid))],matches:ReturnType<WebsiteResolver['match']>[]=[],suggestions:WebsiteSuggestion[]=[];
  for(const pid of pids){
   if(containerForwarder.test(listeners.find(listener=>listener.pid===pid)?.name||''))continue;
   const found=await this.processPath(pid,known);
   if(found){const match=this.match(found.path,known,found.source,found.detail);if(found.auto)matches.push(match);else if(match.projectPath)suggestions.push({projectPath:match.projectPath,source:found.source,detail:found.detail});}
  }
  const distinct=[...new Map(matches.map(m=>[m.projectPath,m])).values()];
  if(distinct.length===1&&matches.length===pids.length)return {match:distinct[0],listeners,suggestions};
  for(const m of distinct)if(m.projectPath)suggestions.push({projectPath:m.projectPath,source:m.source||'port_process',detail:m.detail||'Port owner'});
  return {listeners,suggestions};
 }
 private async dockerPort(port:number,known:KnownWorkspace[]):Promise<{match?:Pick<WebsiteResolution,'projectPath'|'workspaceId'|'source'|'detail'>;suggestions:WebsiteSuggestion[]}>{
  const docker=this.dockerOverride||dockerBinary();if(!docker)return {suggestions:[]};
  // A remote Docker context publishes ports on its host, not on this Mac.
  const endpoint=await this.run(docker,['context','inspect','--format','{{ (index .Endpoints "docker").Host }}'],1200);
  if(!endpoint?.trim().startsWith('unix://'))return {suggestions:[]};
  const ids=await this.run(docker,['ps','-q','--filter',`publish=${port}`],1400);
  if(!ids)return {suggestions:[]};
  const output=await this.run(docker,['inspect',...ids.split('\n').filter(Boolean).slice(0,20)],1800);
  if(!output)return {suggestions:[]};
  try{
   const containers=JSON.parse(output) as Array<any>,matches:ReturnType<WebsiteResolver['match']>[]=[],suggestions:WebsiteSuggestion[]=[];
   for(const container of containers){
    const ports=container.NetworkSettings?.Ports||{};
    if(!Object.values(ports).some((bindings:any)=>Array.isArray(bindings)&&bindings.some((binding:any)=>Number(binding.HostPort)===port)))continue;
    const paths=[...(container.Mounts||[]).filter((m:any)=>m.Type==='bind'&&typeof m.Source==='string').map((m:any)=>m.Source),container.Config?.Labels?.['com.docker.compose.project.working_dir']].filter((p):p is string=>typeof p==='string'&&existsSync(p));
    const knownPaths=[...new Set(paths.map(p=>known.filter(k=>inside(p,k.projectPath)).sort((a,b)=>b.projectPath.length-a.projectPath.length)[0]?.projectPath).filter((p):p is string=>Boolean(p)))];
    if(knownPaths.length===1)matches.push(this.match(knownPaths[0],known,'docker','Docker published port and bind mount'));
    else{
     const name=container.Config?.Labels?.['com.docker.compose.project'];
     for(const k of known)if(typeof name==='string'&&basename(k.projectPath)===name)suggestions.push({projectPath:k.projectPath,source:'docker_compose',detail:`Compose project ${name}`});
    }
   }
   const distinct=[...new Map(matches.map(m=>[m.projectPath,m])).values()];
   if(distinct.length===1)return {match:distinct[0],suggestions};
   return {suggestions:uniqueSuggestions([...suggestions,...distinct.filter(m=>m.projectPath).map(m=>({projectPath:m.projectPath!,source:'docker',detail:'Docker bind mount'}))])};
  }catch{return {suggestions:[]};}
 }
 private declaredPort(port:number,known:KnownWorkspace[]):WebsiteSuggestion[]{
  const suggestions:WebsiteSuggestion[]=[];
  for(const path of [...new Set(known.map(k=>k.projectPath))]){
   for(const name of ['package.json','vite.config.ts','vite.config.js','vite.config.mts','vite.config.mjs','.env','.env.local','compose.yaml','compose.yml','docker-compose.yml']){
    const file=join(path,name);if(!existsSync(file))continue;
    try{if(statSync(file).size>128_000)continue;const text=readFileSync(file,'utf8');
     if(new RegExp(`(?:\\bPORT\\s*=\\s*|\\bport\\s*:\\s*|--port(?:=|\\s+)|(?:127\\.0\\.0\\.1|localhost):|["'])(?:${port})(?:\\b|["'])`).test(text))suggestions.push({projectPath:path,source:'repository_config',detail:`Declared port in ${name}`});
    }catch{/* Unreadable configuration is ignored. */}
   }
  }
  return uniqueSuggestions(suggestions);
 }
 private proxySuggestions(url:URL,known:KnownWorkspace[],listeners:Listener[]):WebsiteSuggestion[]{
  if(!listeners.some(l=>/caddy|nginx|traefik|ssh|kubectl|cloudflare|ngrok/i.test(l.name)))return [];
  const suggestions:WebsiteSuggestion[]=[];
  for(const path of [...new Set(known.map(k=>k.projectPath))])for(const name of ['Caddyfile','nginx.conf']){
   const file=join(path,name);if(!existsSync(file))continue;
   try{if(statSync(file).size>128_000)continue;const text=readFileSync(file,'utf8');if(text.includes(url.hostname))suggestions.push({projectPath:path,source:'proxy_config',detail:`Host appears in ${name}`});}catch{/* Ignore unreadable proxy config. */}
  }
  return uniqueSuggestions(suggestions);
 }
 private async proxyTarget(url:URL,known:KnownWorkspace[],listeners:Listener[],hostPort:number):Promise<Pick<WebsiteResolution,'projectPath'|'workspaceId'|'source'|'detail'>|null>{
  if(!listeners.some(l=>/caddy|nginx|traefik/i.test(l.name)))return null;
  const files=new Set<string>();
  for(const path of [...new Set(known.map(k=>k.projectPath))])for(const name of ['Caddyfile','nginx.conf'])files.add(join(path,name));
  for(const listener of listeners){
   const command=await this.run('/bin/ps',['-p',String(listener.pid),'-o','command='],1000);
   const config=command?.match(/(?:--config|-c)\s+([^\s]+)/)?.[1];
   if(config?.startsWith('/'))files.add(config);
  }
  const targets=new Set<number>();
  for(const file of files){
   if(!existsSync(file))continue;
   try{
    if(statSync(file).size>128_000)continue;
    const body=readFileSync(file,'utf8');
    const escaped=url.hostname.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const caddy=new RegExp(`(?:^|\\n)\\s*${escaped}(?::${hostPort})?\\s*\\{([^}]*)\\}`,'i').exec(body)?.[1];
    const nginx=new RegExp(`server_name\\s+[^;]*\\b${escaped}\\b[^;]*;([\\s\\S]{0,4000}?)(?=\\n\\s*server\\s*\\{|$)`,'i').exec(body)?.[1];
    for(const block of [caddy,nginx].filter((b):b is string=>typeof b==='string')){
     const matches=[...block.matchAll(/(?:reverse_proxy\s+|proxy_pass\s+https?:\/\/)(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\]):(\d{2,5})/g)];
     for(const match of matches)targets.add(Number(match[1]));
    }
   }catch{/* Unreadable proxy configuration remains unresolved. */}
  }
  if(targets.size!==1)return null;
  const target=[...targets][0];if(target===hostPort)return null;
  const upstream=await this.portOwner(target,known);
  return upstream.match?{...upstream.match,source:'proxy_config',detail:`Proxy host ${url.hostname} routes to local port ${target}`}:null;
 }
 async resolve(raw:string,known:KnownWorkspace[],recentOrca?:{workspaceId:string;observedAt:number}):Promise<WebsiteResolution|null>{
  let url:URL;try{url=new URL(raw);if(!['http:','https:'].includes(url.protocol))return null;}catch{return null;}
  const key=websiteKey(raw,this.savedRules)!;
  const result:WebsiteResolution={key,origin:url.origin,url:raw,observedAt:Date.now()/1000,suggestions:[]};
  const rule=matchingRule(url,this.savedRules);
  if(rule)return {...result,...this.match(rule.projectPath,known,'rule',`User rule ${rule.pattern}`)};
  const slug=githubPageSlug(url);
  if(slug){
   const paths=(await this.remotes(known)).get(slug)||[];
   if(paths.length===1)return {...result,...this.match(paths[0],known,'git_remote',`Local clone remote matches ${slug}`)};
   result.suggestions.push(...paths.map(path=>({projectPath:path,source:'git_remote',detail:`Multiple clones match ${slug}`})));
  }
  if(localHost(url.hostname)){
   const port=Number(url.port||(url.protocol==='https:'?'443':'80'));
   if(Number.isInteger(port)&&port>0&&port<=65535){
    const owner=await this.portOwner(port,known);
    if(owner.match)return {...result,...owner.match};
    result.suggestions.push(...owner.suggestions);
    const docker=await this.dockerPort(port,known);
    if(docker.match)return {...result,...docker.match};
    const proxy=await this.proxyTarget(url,known,owner.listeners,port);
    if(proxy)return {...result,...proxy};
    result.suggestions.push(...docker.suggestions,...this.proxySuggestions(url,known,owner.listeners),...this.declaredPort(port,known));
   }
  }
  if(recentOrca&&Date.now()/1000-recentOrca.observedAt<=120){
   const path=recentOrca.workspaceId.split('::').at(-1);
   if(path&&existsSync(path))result.suggestions.push({projectPath:projectPathFromWorktree(path),source:'recent_orca',detail:'Recently active Orca worktree'});
  }
  result.suggestions=uniqueSuggestions(result.suggestions);
  return result;
 }
}
