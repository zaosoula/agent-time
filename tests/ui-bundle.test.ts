import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync,existsSync} from 'node:fs';
import {dirname,resolve} from 'node:path';

// The dashboard runs in a webview: a runtime import of a Node built-in there
// (even several modules away) leaves a blank window, so walk the UI graph.
test('the dashboard never imports Node built-ins at runtime',()=>{
 const seen=new Set<string>(),offenders:string[]=[];
 const visit=(file:string,chain:string[])=>{
  if(seen.has(file))return;seen.add(file);
  const text=readFileSync(file,'utf8');
  const source=file.endsWith('.vue')?(text.match(/<script[^>]*>([\s\S]*?)<\/script>/g)||[]).join('\n'):text;
  for(const match of source.matchAll(/^\s*import\s+(?!type\b)([^'"]*?)\s*from\s*['"]([^'"]+)['"]|^\s*export\s+(?!type\b)[^'"]*?\s+from\s*['"]([^'"]+)['"]/gm)){
   const clause=match[1]??'',specifier=match[2]??match[3]!;
   if(/^\{[^}]*\}$/.test(clause.trim())&&clause.replace(/[{}]/g,'').split(',').every(part=>part.trim().startsWith('type ')||!part.trim()))continue;
   if(specifier.startsWith('node:')){offenders.push([...chain,file,specifier].map(p=>p.replace(process.cwd()+'/','')).join(' → '));continue;}
   if(!specifier.startsWith('.'))continue;
   const target=resolve(dirname(file),specifier);
   if(existsSync(target))visit(target,[...chain,file]);
  }
 };
 visit(resolve('src/ui/main.ts'),[]);
 assert.deepEqual(offenders,[]);
});
