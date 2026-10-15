import {execFile,spawn} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {existsSync,lstatSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {createServer,type Server} from 'node:http';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {githubRemoteSlug} from './website-resolver.ts';

export const LINEAR_REDIRECT_URI='http://127.0.0.1:37642/linear/callback';
export const LINEAR_CLIENT_ID='229a064267cca2cc21ad2d675e13193d';
const clientIdPattern=/^[A-Za-z0-9_-]{8,128}$/;
interface TokenSet {accessToken:string;refreshToken:string;expiresAt:number;clientId:string;workspaceId:string;}
export interface LinearProject {id:string;name:string;url:string;repositories:string[];sites:string[];linksIncomplete:boolean;}
interface Cache {viewerName:string;workspaceId:string;workspaceName:string;projects:LinearProject[];syncedAt:number;}
export interface LinearWorkspace extends Cache {error:string|null;}
export interface LinearStatus {phase:'disconnected'|'connecting'|'connected'|'error';clientId:string;workspaces:LinearWorkspace[];projectCount:number;projects:LinearProject[];redirectUri:string;error:string|null;}
type Keychain=(operation:'read'|'write'|'delete',value?:string)=>Promise<string|null>;
type Fetcher=typeof fetch;
const exec=promisify(execFile);

function privateJson(path:string,value:unknown){
 if(existsSync(path)&&lstatSync(path).isSymbolicLink())throw new Error('Linear state path is a symlink');
 const temp=path+'.tmp';writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});renameSync(temp,path);
}
function loadJson(path:string):unknown{
 if(!existsSync(path))return null;
 if(lstatSync(path).isSymbolicLink())throw new Error('Linear state path is a symlink');
 return JSON.parse(readFileSync(path,'utf8'));
}
export function keychainHelper(path:string):Keychain {
 return (operation,value)=>new Promise((resolve,reject)=>{
  const child=spawn(path,[operation],{stdio:['pipe','pipe','pipe']});
  const chunks:Buffer[]=[];let size=0,failed=false;
  child.stdout.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>16_384){failed=true;child.kill();}else chunks.push(chunk);});
  child.on('error',reject);
  child.on('close',code=>{
   if(failed)return reject(new Error('Keychain item too large'));
   if(code===2&&operation==='read')return resolve(null);
   if(code!==0)return reject(new Error('macOS Keychain operation failed'));
   resolve(operation==='read'?Buffer.concat(chunks).toString('utf8'):null);
  });
  child.stdin.end(value||'');
 });
}
function validTokens(value:unknown):TokenSet|null{
 if(!value||typeof value!=='object')return null;
 const t=value as Partial<TokenSet>;
 return typeof t.accessToken==='string'&&typeof t.refreshToken==='string'&&typeof t.expiresAt==='number'&&typeof t.clientId==='string'&&typeof t.workspaceId==='string'?t as TokenSet:null;
}
function escapeHtml(value:string){return value.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));}
export function linearReturnPage(result:'connected'|'reconnected'|'error',workspaceName?:string):string{
 const name=workspaceName?escapeHtml(workspaceName):'Linear workspace';
 const title=result==='connected'?`${name} connected`:result==='reconnected'?`${name} is already connected`:'Connection incomplete';
 const description=result==='connected'?'Its projects are now available in Agent Time.':result==='reconnected'?'To add a different workspace, switch to it in Linear, then choose Add Linear workspace again.':'Return to Agent Time to review the connection and try again.';
 const icon=result==='error'?'!':'✓';
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${title} · Agent Time</title><style>
:root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13px;font-synthesis:none;--bg:#fafafa;--panel:#fff;--text:#25262b;--muted:#7a7c86;--border:#e3e4e8;--blue:#007aff;--hover:#f1f2f5;--green:#35a77d;--amber:#c58b3e}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);padding:24px}main{width:min(100%,480px)}header{display:flex;align-items:center;gap:10px;margin-bottom:22px;font-size:16px;font-weight:650;letter-spacing:-.3px}.mark{width:30px;height:30px;display:grid;place-items:center;border:1px solid var(--border);border-radius:9px;background:var(--panel);color:var(--muted)}.mark svg{width:17px;height:17px}section{background:var(--panel);border:1px solid var(--border);border-radius:10px;overflow:hidden}article{padding:26px 28px 30px}.connection{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:11px;font-weight:600}.dot{width:8px;height:8px;border-radius:50%;background:${result==='error'?'var(--amber)':'var(--green)'}}h1{font-size:24px;font-weight:650;letter-spacing:-.65px;line-height:1.3;margin:22px 0 8px;overflow-wrap:anywhere}p{margin:0;color:var(--muted);font-size:12px;line-height:1.65}.close{border-top:1px solid var(--border);padding:15px 28px;background:var(--hover);font-size:11px;color:var(--muted)}.close strong{color:var(--text);font-weight:550}.status{margin-left:auto;color:${result==='error'?'var(--amber)':'var(--green)'};font-size:13px}@media(prefers-color-scheme:dark){:root{--bg:#202125;--panel:#25262c;--text:#e2e3e8;--muted:#989ba6;--border:#383a43;--hover:#34363f}.mark{background:#343740;border-color:#434752;color:#b8bfce}}@media(max-width:500px){article{padding:23px}.close{padding:15px 23px}}
</style></head><body><main><header><span class="mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></span>Agent Time</header><section><article><div class="connection"><span class="dot" aria-hidden="true"></span>Linear<span class="status" aria-hidden="true">${icon}</span></div><h1>${title}</h1><p>${description}</p></article><div class="close"><strong>You can close this window.</strong> ${result==='error'?'Check Agent Time for details.':'Your connection is saved in Agent Time.'}</div></section></main></body></html>`;
}
function cleanProject(value:any):LinearProject|null{
 if(typeof value?.id!=='string'||typeof value?.name!=='string'||typeof value?.url!=='string')return null;
 const links=Array.isArray(value.externalLinks?.nodes)?value.externalLinks.nodes:[];
 const repositories:string[]=[],sites:string[]=[];
 for(const link of links){
  if(typeof link?.url!=='string')continue;
  const slug=githubRemoteSlug(link.url);
  if(slug){if(!repositories.includes(slug))repositories.push(slug);continue;}
  try{
   const url=new URL(link.url);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)continue;
   const pattern=url.origin+(url.pathname==='/'?'':url.pathname.replace(/\/$/,''));
   if(!sites.includes(pattern))sites.push(pattern);
  }catch{/* Ignore non-website resources. */}
 }
 return {id:value.id,name:value.name,url:value.url,repositories,sites,linksIncomplete:value.externalLinks?.pageInfo?.hasNextPage===true};
}

export class LinearConnection {
 private cachePath:string;private caches=new Map<string,Cache>();private tokens=new Map<string,TokenSet>();
 private keychain:Keychain;private fetcher:Fetcher;private openUrl:(url:string)=>Promise<void>;private redirectUri:string;
 private loaded=false;private server:Server|null=null;private timeout:ReturnType<typeof setTimeout>|null=null;
 private autoTimer:ReturnType<typeof setInterval>;private initialTimer:ReturnType<typeof setTimeout>;private lastAutoAttempt=0;
 private error:string|null=null;private errors=new Map<string,string>();
 constructor(output:string,keychain:Keychain,fetcher:Fetcher=fetch,openUrl:(url:string)=>Promise<void>=async url=>{await exec('/usr/bin/open',[url],{timeout:5000});},redirectUri=LINEAR_REDIRECT_URI){
  this.keychain=keychain;this.fetcher=fetcher;this.openUrl=openUrl;this.redirectUri=redirectUri;this.cachePath=join(output,'linear-projects.json');
  try{
   const raw=loadJson(this.cachePath);
   const caches=Array.isArray(raw)?raw:raw?[raw]:[];
   for(const cache of caches)if(cache&&typeof cache.viewerName==='string'&&typeof cache.workspaceId==='string'&&cache.workspaceId&&typeof cache.workspaceName==='string'&&Array.isArray(cache.projects)&&Number.isFinite(cache.syncedAt))this.caches.set(cache.workspaceId,cache);
  }catch{this.error='Linear connection data is unreadable';}
  this.autoTimer=setInterval(()=>{void this.maybeSync();},6*60*60_000);this.autoTimer.unref();
  this.initialTimer=setTimeout(()=>{void this.maybeSync();},10_000);this.initialTimer.unref();
 }
 private async maybeSync(){
  try{
   await this.loadTokens();const now=Date.now()/1000;
   if(now-this.lastAutoAttempt<60*60)return;
   const due=[...this.tokens.keys()].filter(id=>!this.caches.has(id)||now-(this.caches.get(id)?.syncedAt||0)>=24*60*60);
   if(!due.length)return;this.lastAutoAttempt=now;
   for(const id of due)try{await this.sync(id);}catch{/* Keep other workspaces available. */}
  }catch{/* Settings exposes the error. */}
 }
 private async loadTokens(){
  if(this.loaded)return;
  const raw=await this.keychain('read');
  try{
   const parsed=raw?JSON.parse(raw):[];
   const values=Array.isArray(parsed)?parsed:[parsed];
   for(const value of values){
    const legacy=value&&!value.workspaceId?{...value,workspaceId:[...this.caches.keys()][0]}:value;
    const token=validTokens(legacy);if(token&&clientIdPattern.test(token.clientId))this.tokens.set(token.workspaceId,token);
   }
  }catch{this.error='Stored Linear credential is unreadable';}
  this.loaded=true;
 }
 private async saveTokens(){await this.keychain(this.tokens.size?'write':'delete',this.tokens.size?JSON.stringify([...this.tokens.values()]):undefined);}
 private saveCaches(){privateJson(this.cachePath,[...this.caches.values()]);}
 async status():Promise<LinearStatus>{
  await this.loadTokens();
  const workspaces=[...this.tokens.keys()].map(id=>({...this.caches.get(id)||{viewerName:'',workspaceId:id,workspaceName:'Linear workspace',projects:[],syncedAt:0},error:this.errors.get(id)||null}));
  const projects=workspaces.flatMap(workspace=>workspace.projects);
  return {phase:this.server?'connecting':workspaces.length?'connected':this.error?'error':'disconnected',clientId:LINEAR_CLIENT_ID,workspaces,projectCount:projects.length,projects,redirectUri:this.redirectUri,error:this.error};
 }
 private async graphQL<T>(query:string,variables:Record<string,unknown>,access:string):Promise<T>{
  const response=await this.fetcher('https://api.linear.app/graphql',{method:'POST',headers:{'Authorization':`Bearer ${access}`,'Content-Type':'application/json'},body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(15_000)});
  if(!response.ok)throw new Error(`Linear API returned ${response.status}`);
  const body=await response.json() as {data?:T;errors?:unknown[]};
  if(body.errors?.length||!body.data)throw new Error('Linear rejected the read-only query');
  return body.data;
 }
 private async accessToken(id:string):Promise<string>{
  await this.loadTokens();const token=this.tokens.get(id);if(!token)throw new Error('Connect Linear first');
  if(Date.now()/1000<token.expiresAt-60)return token.accessToken;
  const body=new URLSearchParams({grant_type:'refresh_token',refresh_token:token.refreshToken,client_id:token.clientId});
  const response=await this.fetcher('https://api.linear.app/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body,signal:AbortSignal.timeout(15_000)});
  if(!response.ok)throw new Error('Linear connection expired; reconnect it');
  const result=await response.json() as {access_token?:string;refresh_token?:string;expires_in?:number};
  if(!result.access_token||!result.refresh_token||!Number.isFinite(result.expires_in))throw new Error('Invalid Linear refresh response');
  const next={...token,accessToken:result.access_token,refreshToken:result.refresh_token,expiresAt:Date.now()/1000+result.expires_in!};
  this.tokens.set(id,next);await this.saveTokens();return next.accessToken;
 }
 async connect(clientId=LINEAR_CLIENT_ID):Promise<LinearStatus>{
  if(!clientIdPattern.test(clientId))throw new Error('Invalid Linear OAuth client ID');
  if(this.server)throw new Error('Linear sign-in is already open');
  await this.loadTokens();this.error=null;
  const verifier=randomBytes(32).toString('base64url');const state=randomBytes(32).toString('base64url');
  const challenge=createHash('sha256').update(verifier).digest('base64url');
  let consumed=false;
  const server=createServer((request,response)=>{
   response.setHeader('Content-Type','text/html; charset=utf-8');response.setHeader('Cache-Control','no-store');response.setHeader('Referrer-Policy','no-referrer');
   response.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'");
   if(request.method!=='GET'||request.url?.split('?')[0]!=='/linear/callback'){response.writeHead(404).end('Not found');return;}
   let callback:URL;try{callback=new URL(request.url,this.redirectUri);}catch{response.writeHead(400).end(linearReturnPage('error'));return;}
   if(callback.searchParams.get('state')!==state){response.writeHead(400).end(linearReturnPage('error'));return;}
   if(consumed){response.writeHead(409).end(linearReturnPage('error'));return;}
   const code=callback.searchParams.get('code');
   if(!code){response.writeHead(400).end(linearReturnPage('error'));this.finish();return;}
   consumed=true;
   void this.exchange(code,verifier,clientId).then(result=>{response.writeHead(200).end(linearReturnPage(result.isNew?'connected':'reconnected',result.workspaceName));})
    .catch(()=>{response.writeHead(500).end(linearReturnPage('error'));}).finally(()=>this.finish());
  });
  try{
   const callbackUrl=new URL(this.redirectUri);
   await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(Number(callbackUrl.port),'127.0.0.1',resolve);});this.server=server;
   this.timeout=setTimeout(()=>{this.error='Linear sign-in timed out';this.finish();},5*60_000);
   const authorize=new URL('https://linear.app/oauth/authorize');
   for(const [key,value] of Object.entries({client_id:clientId,redirect_uri:this.redirectUri,response_type:'code',scope:'read',actor:'user',prompt:'consent',state,code_challenge:challenge,code_challenge_method:'S256'}))authorize.searchParams.set(key,value);
   await this.openUrl(authorize.toString());
  }catch(error){this.error=String(error);this.finish();throw error;}
  return this.status();
 }
 private async exchange(code:string,verifier:string,clientId:string){
  try{
   const body=new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:this.redirectUri,client_id:clientId,code_verifier:verifier});
   const response=await this.fetcher('https://api.linear.app/oauth/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body,signal:AbortSignal.timeout(15_000)});
   if(!response.ok)throw new Error(`Linear token exchange returned ${response.status}`);
   const result=await response.json() as {access_token?:string;refresh_token?:string;expires_in?:number;scope?:string};
   const scopes=String(result.scope||'').split(/[ ,]+/).filter(Boolean);
   if(!result.access_token||!result.refresh_token||!Number.isFinite(result.expires_in)||scopes.length!==1||scopes[0]!=='read')throw new Error('Linear did not grant read-only access');
   const viewer=await this.graphQL<{viewer:{name:string};organization:{id:string;name:string}}>('query AgentTimeViewer { viewer { name } organization { id name } }',{},result.access_token);
   const id=viewer.organization.id;if(!id)throw new Error('Linear workspace ID missing');
   const isNew=!this.tokens.has(id);
   const next={accessToken:result.access_token,refreshToken:result.refresh_token,expiresAt:Date.now()/1000+result.expires_in!,clientId,workspaceId:id};
   this.tokens.set(id,next);await this.saveTokens();this.loaded=true;
   this.caches.set(id,{viewerName:viewer.viewer.name,workspaceId:id,workspaceName:viewer.organization.name,projects:this.caches.get(id)?.projects||[],syncedAt:this.caches.get(id)?.syncedAt||0});this.saveCaches();this.error=null;this.errors.delete(id);
   try{await this.sync(id);}catch{/* Connection remains usable; Settings shows sync error. */}
   return {isNew,workspaceName:viewer.organization.name};
  }catch(error){this.error=String(error);throw error;}
 }
 async sync(workspaceId?:string):Promise<LinearStatus>{
  await this.loadTokens();if(!this.tokens.size)throw new Error('Connect Linear first');
  const ids=workspaceId?[workspaceId]:[...this.tokens.keys()];
  for(const id of ids){
   if(!this.tokens.has(id))throw new Error('Unknown Linear workspace');
   try{
    const access=await this.accessToken(id),projects:LinearProject[]=[];let after:string|null=null,complete=false;
    for(let page=0;page<100;page++){
     const data:{projects:{nodes:any[];pageInfo:{hasNextPage:boolean;endCursor:string|null}}}=await this.graphQL<{projects:{nodes:any[];pageInfo:{hasNextPage:boolean;endCursor:string|null}}}>(
      'query AgentTimeProjects($after: String) { projects(first: 50, after: $after) { nodes { id name url externalLinks(first: 50) { nodes { url label } pageInfo { hasNextPage } } } pageInfo { hasNextPage endCursor } } }',{after},access);
     for(const value of data.projects.nodes){const project=cleanProject(value);if(project)projects.push(project);}
     if(!data.projects.pageInfo.hasNextPage){complete=true;break;}
     after=data.projects.pageInfo.endCursor;if(!after)break;
    }
    if(!complete)throw new Error('Linear project list was incomplete');
    const previous=this.caches.get(id);
    this.caches.set(id,{viewerName:previous?.viewerName||'',workspaceId:id,workspaceName:previous?.workspaceName||'',projects,syncedAt:Date.now()/1000});
    this.saveCaches();this.errors.delete(id);
   }catch(error){this.errors.set(id,String(error));if(workspaceId)throw error;}
  }
  return this.status();
 }
 async disconnect(workspaceId?:string):Promise<LinearStatus>{
  if(this.server&&!workspaceId){this.finish();this.error=null;return this.status();}
  this.finish();await this.loadTokens();
  if(workspaceId&&!this.tokens.has(workspaceId))throw new Error('Unknown Linear workspace');
  if(workspaceId){this.tokens.delete(workspaceId);this.caches.delete(workspaceId);this.errors.delete(workspaceId);}
  else{this.tokens.clear();this.caches.clear();this.errors.clear();}
  await this.saveTokens();this.saveCaches();this.error=null;return this.status();
 }
 private finish(){if(this.timeout)clearTimeout(this.timeout);this.timeout=null;this.server?.close();this.server=null;}
 close(){this.finish();clearInterval(this.autoTimer);clearTimeout(this.initialTimer);}
}
