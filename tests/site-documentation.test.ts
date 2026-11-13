import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm,writeFile,mkdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBetaFeed} from '../beta-feed/server.mjs';
import {DOC_PAGES} from '../beta-feed/docs-content.mjs';
import {documentationPaths,renderDocumentation} from '../beta-feed/documentation.mjs';

test('public guide routes preserve downloads, restrictive CSP and complete internal navigation',async()=>{
 const dataDir=await mkdtemp(join(tmpdir(),'agent-time-guides-')),origin='https://agent-time.example.test',version='0.2.0-beta.49';
 await writeFile(join(dataDir,'installer-current'),version);
 await mkdir(join(dataDir,'installers',version),{recursive:true});
 const name=`Agent Time_${version}_aarch64.dmg`;await writeFile(join(dataDir,'installers',version,name),'installer fixture');
 const server=createServer(createBetaFeed({dataDir,uploadToken:'a'.repeat(64),publicOrigin:origin}));
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 try{
  const pages=new Map<string,string>();
  for(const path of ['/',...documentationPaths()]){
   const response=await fetch(base+path),html=await response.text();pages.set(path,html);
   assert.equal(response.status,200,path);assert.match(response.headers.get('content-type')||'',/text\/html/);
   assert.match(response.headers.get('content-security-policy')||'',/default-src 'none'/);
   assert.doesNotMatch(response.headers.get('content-security-policy')||'',/script-src 'unsafe-inline'/);
   assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('x-robots-tag'),null);
   assert.equal((html.match(/<h1\b/g)||[]).length,1,path);assert.doesNotMatch(html,/<script\b|\sonclick=/i,path);
   assert.ok(html.includes(version),path);assert.match(html,/Skip to content/);
  }
  // Check every local navigation target, including cross-guide section links.
  for(const [path,html] of pages)for(const match of html.matchAll(/href="([^"]+)"/g)){
   const href=match[1]!.replaceAll('&amp;','&'),url=new URL(href,origin+path);
   if(url.origin!==origin)continue;
   if(url.pathname.startsWith('/docs'))assert.ok(pages.has(url.pathname),`${path}: unknown guide ${href}`);
   if(!pages.has(url.pathname))continue;
   if(url.hash)assert.ok(pages.get(url.pathname)!.includes(`id="${decodeURIComponent(url.hash.slice(1))}"`),`${path}: ${href}`);
  }
  for(const page of DOC_PAGES){assert.ok(pages.get('/')!.includes(`/docs/${page.slug}`));assert.ok(pages.get(`/docs/${page.slug}`)!.includes('aria-current="page"'));}
  assert.equal((await fetch(base+'/docs/',{redirect:'manual'})).status,308);
  const missing=await fetch(base+'/docs/unknown-guide');assert.equal(missing.status,404);assert.equal(missing.headers.get('x-robots-tag'),'noindex');assert.match(await missing.text(),/Browse all guides/);
  assert.equal((await fetch(base+'/docs/../../admin/installers/current')).status,401);
  assert.equal((await fetch(base+'/admin/manifest/promote',{method:'POST'})).status,401);
  const installer=await fetch(base+`/install/${version}/${encodeURIComponent(name)}`);assert.equal(installer.status,200);assert.equal(await installer.text(),'installer fixture');
  const sitemap=await (await fetch(base+'/sitemap.xml')).text();for(const path of documentationPaths())assert.ok(sitemap.includes(`<loc>${origin}${path}</loc>`));assert.doesNotMatch(sitemap,/admin|\/install\//);
  assert.match(await (await fetch(base+'/robots.txt')).text(),/Disallow: \/admin\//);
  for(const asset of ['/icon.png','/manrope.ttf']){const response=await fetch(base+asset);assert.equal(response.status,200);await response.arrayBuffer();}
  await rm(join(dataDir,'installer-current'));
  const waiting=await (await fetch(base+'/docs/mcp')).text();assert.doesNotMatch(waiting,/class="download"/);assert.match(waiting,/MCP/);
 }finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await rm(dataDir,{recursive:true,force:true});}
});

test('guide labels and version are escaped while unsafe download schemes are rejected',()=>{
 const html=renderDocumentation({slug:'mcp',version:'<img src=x onerror="bad">',installLink:'javascript:bad()'});
 assert.ok(html.includes('&lt;img'));assert.doesNotMatch(html,/<img src=x|href="javascript:/);assert.doesNotMatch(html,/<script\b/);
});

test('all guide modules are included in the production image',async()=>{
 const docker=await readFile(new URL('../beta-feed/Dockerfile',import.meta.url),'utf8');
 for(const path of ['documentation.mjs','docs-content.mjs','landing.mjs'])assert.ok(docker.includes(path));
});
