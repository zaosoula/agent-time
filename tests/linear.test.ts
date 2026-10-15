import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {LinearConnection,LINEAR_CLIENT_ID,linearReturnPage} from '../src/capture/linear.ts';

async function unusedPort():Promise<number>{
 const server=createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();if(!address||typeof address==='string')throw new Error('No test port');
 const port=address.port;await new Promise<void>(resolve=>server.close(()=>resolve()));return port;
}
const response=(value:unknown)=>new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});

test('Linear PKCE connects with read scope, validates state and caches project Resources',async()=>{
 const output=mkdtempSync(join(tmpdir(),'agent-time-linear-')),port=await unusedPort(),redirect=`http://127.0.0.1:${port}/linear/callback`;
 let secret:string|null=null,authUrl='',queries:string[]=[];
 const keychain=async(operation:'read'|'write'|'delete',value?:string)=>{
  if(operation==='read')return secret;
  secret=operation==='write'?value||null:null;return null;
 };
 const fetcher=async(input:RequestInfo|URL,init?:RequestInit)=>{
  if(String(input).endsWith('/oauth/token')){
   const body=init?.body as URLSearchParams;
   assert.equal(body.get('grant_type'),'authorization_code');
   assert.equal(body.get('redirect_uri'),redirect);
   assert.ok(body.get('code_verifier'));
   assert.equal(body.has('client_secret'),false);
   return response({access_token:'access',refresh_token:'refresh',expires_in:86400,scope:'read'});
  }
  assert.equal(init?.headers&&new Headers(init.headers).get('Authorization'),'Bearer access');
  const body=JSON.parse(String(init?.body));queries.push(body.query);
  if(body.query.includes('AgentTimeViewer'))return response({data:{viewer:{name:'User'},organization:{id:'workspace-id',name:'Workspace'}}});
  return response({data:{projects:{nodes:[{id:'project-id',name:'Kuva',url:'https://linear.app/team/project/kuva',externalLinks:{nodes:[{url:'https://github.com/acme/kuva',label:'Repository'},{url:'https://app.kuva.test/dashboard',label:'App'}],pageInfo:{hasNextPage:false}}}],pageInfo:{hasNextPage:false,endCursor:null}}}});
 };
 const linear=new LinearConnection(output,keychain,fetcher as typeof fetch,async url=>{authUrl=url;},redirect);
 try{
  assert.equal((await linear.status()).clientId,LINEAR_CLIENT_ID);
  await assert.rejects(linear.connect('bad'));
  const pending=await linear.connect('test-client-id');
  assert.equal(pending.phase,'connecting');
  const authorize=new URL(authUrl);
  assert.equal(authorize.searchParams.get('scope'),'read');
  assert.equal(authorize.searchParams.get('prompt'),'consent');
  assert.equal(authorize.searchParams.get('code_challenge_method'),'S256');
  assert.equal(authorize.searchParams.get('redirect_uri'),redirect);
  assert.equal(authorize.searchParams.has('client_secret'),false);
  const invalid=await fetch(redirect+'?code=wrong&state=wrong');assert.equal(invalid.status,400);assert.match(await invalid.text(),/You can close this window/);
  const callback=new URL(redirect);callback.searchParams.set('code','valid-code');callback.searchParams.set('state',authorize.searchParams.get('state')!);
  const returned=await fetch(callback);assert.equal(returned.status,200);const page=await returned.text();assert.match(page,/You can close this window/);assert.match(page,/Workspace connected/);
  const status=await linear.status();
  assert.equal(status.phase,'connected');
  assert.equal(status.workspaces[0]?.viewerName,'User');
  assert.equal(status.workspaces[0]?.workspaceName,'Workspace');
  assert.deepEqual(status.projects[0]?.repositories,['acme/kuva']);
  assert.deepEqual(status.projects[0]?.sites,['https://app.kuva.test/dashboard']);
  assert.ok(queries.every(query=>query.trimStart().startsWith('query ')));
  assert.equal(JSON.parse(secret!)[0].clientId,'test-client-id');
  assert.equal((await linear.disconnect()).phase,'disconnected');
  assert.equal(secret,null);
 }finally{linear.close();rmSync(output,{recursive:true});}
});

test('expired Linear tokens refresh without a client secret',async()=>{
 const output=mkdtempSync(join(tmpdir(),'agent-time-linear-refresh-'));
 writeFileSync(join(output,'linear-connection.json'),JSON.stringify({clientId:'test-client-id'}));
 writeFileSync(join(output,'linear-projects.json'),JSON.stringify({viewerName:'User',workspaceId:'legacy-workspace',workspaceName:'Legacy',projects:[],syncedAt:0}));
 let secret=JSON.stringify({clientId:'test-client-id',accessToken:'old',refreshToken:'old-refresh',expiresAt:1}),refreshed=false;
 const keychain=async(operation:'read'|'write'|'delete',value?:string)=>{
  if(operation==='read')return secret;
  secret=operation==='write'?value||'':'';return null;
 };
 const fetcher=async(input:RequestInfo|URL,init?:RequestInit)=>{
  if(String(input).endsWith('/oauth/token')){
   const body=init?.body as URLSearchParams;
   assert.equal(body.get('grant_type'),'refresh_token');assert.equal(body.get('refresh_token'),'old-refresh');assert.equal(body.has('client_secret'),false);
   refreshed=true;return response({access_token:'new',refresh_token:'new-refresh',expires_in:86400});
  }
  assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer new');
  return response({data:{projects:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}}});
 };
 const linear=new LinearConnection(output,keychain,fetcher as typeof fetch);
 try{assert.equal((await linear.sync()).phase,'connected');assert.equal(refreshed,true);assert.equal(JSON.parse(secret)[0].refreshToken,'new-refresh');}
 finally{linear.close();rmSync(output,{recursive:true});}
});

test('Linear tokens with write scope are refused before Keychain storage',async()=>{
 const output=mkdtempSync(join(tmpdir(),'agent-time-linear-scope-')),port=await unusedPort(),redirect=`http://127.0.0.1:${port}/linear/callback`;
 let authUrl='',writes=0;
 const keychain=async(operation:'read'|'write'|'delete')=>{if(operation==='write')writes++;return null;};
 const fetcher=async()=>response({access_token:'access',refresh_token:'refresh',expires_in:86400,scope:'read write'});
 const linear=new LinearConnection(output,keychain,fetcher as typeof fetch,async url=>{authUrl=url;},redirect);
 try{
  await linear.connect('test-client-id');
  const callback=new URL(redirect);callback.searchParams.set('code','code');callback.searchParams.set('state',new URL(authUrl).searchParams.get('state')!);
  assert.equal((await fetch(callback)).status,500);
  assert.equal(writes,0);
  assert.equal((await linear.status()).phase,'error');
 }finally{linear.close();rmSync(output,{recursive:true});}
});

test('multiple Linear workspaces stay separate across sync, reconnect, and disconnect',async()=>{
 const output=mkdtempSync(join(tmpdir(),'agent-time-linear-multi-')),port=await unusedPort(),redirect=`http://127.0.0.1:${port}/linear/callback`;
 let secret:string|null=null,authUrl='',nextWorkspace='one';
 const keychain=async(operation:'read'|'write'|'delete',value?:string)=>{
  if(operation==='read')return secret;
  secret=operation==='write'?value||null:null;return null;
 };
 const fetcher=async(input:RequestInfo|URL,init?:RequestInit)=>{
  if(String(input).endsWith('/oauth/token'))return response({access_token:nextWorkspace,refresh_token:`refresh-${nextWorkspace}`,expires_in:86400,scope:'read'});
  const access=new Headers(init?.headers).get('Authorization')?.replace('Bearer ','');
  const query=JSON.parse(String(init?.body)).query as string;
  if(query.includes('AgentTimeViewer'))return response({data:{viewer:{name:`User ${access}`},organization:{id:access,name:`Workspace ${access}`}}});
  return response({data:{projects:{nodes:[{id:`project-${access}`,name:`Project ${access}`,url:`https://linear.app/${access}`,externalLinks:{nodes:[],pageInfo:{hasNextPage:false}}}],pageInfo:{hasNextPage:false,endCursor:null}}}});
 };
 const linear=new LinearConnection(output,keychain,fetcher as typeof fetch,async url=>{authUrl=url;},redirect);
 async function authorize(){
  const pending=await linear.connect();assert.equal(pending.phase,'connecting');assert.equal(new URL(authUrl).searchParams.get('client_id'),LINEAR_CLIENT_ID);
  const callback=new URL(redirect);callback.searchParams.set('code',`code-${nextWorkspace}`);callback.searchParams.set('state',new URL(authUrl).searchParams.get('state')!);
  const returned=await fetch(callback);assert.equal(returned.status,200);return returned.text();
 }
 try{
  assert.match(await authorize(),/Workspace one connected/);nextWorkspace='two';assert.match(await authorize(),/Workspace two connected/);
  let status=await linear.status();assert.deepEqual(status.workspaces.map(workspace=>workspace.workspaceId),['one','two']);assert.equal(status.projectCount,2);
  await linear.sync('one');assert.equal((await linear.status()).workspaces.length,2);
  nextWorkspace='one';assert.match(await authorize(),/Workspace one is already connected/);status=await linear.status();assert.equal(status.workspaces.length,2);
  await linear.disconnect('one');status=await linear.status();assert.deepEqual(status.workspaces.map(workspace=>workspace.workspaceId),['two']);
  assert.deepEqual(JSON.parse(secret!).map((token:{workspaceId:string})=>token.workspaceId),['two']);
  const reopened=new LinearConnection(output,keychain,fetcher as typeof fetch,async()=>{},redirect);
  try{assert.deepEqual((await reopened.status()).workspaces.map(workspace=>workspace.workspaceId),['two']);}finally{reopened.close();}
 }finally{linear.close();rmSync(output,{recursive:true});}
});

test('Linear return page uses Agent Time colors and escapes workspace names',()=>{
 const page=linearReturnPage('connected','<script>alert("x")</script>');
 assert.match(page,/--blue:#007aff/);
 assert.match(page,/--panel:#25262c/);
 assert.match(page,/You can close this window/);
 assert.doesNotMatch(page,/<script>/);
 assert.match(page,/&lt;script&gt;/);
});
