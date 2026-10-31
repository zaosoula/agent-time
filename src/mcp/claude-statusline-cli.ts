import {DatabaseSync} from 'node:sqlite';
import {existsSync,readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import type {CaptureEvent} from '../capture/events.ts';
import {renderClaudeReportedStatus} from './claude-statusline.ts';

function readInput():Promise<string>{return new Promise(resolve=>{let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',(chunk:string)=>{input+=chunk;if(input.length>65536)process.stdin.destroy();});process.stdin.on('end',()=>resolve(input));process.stdin.on('close',()=>resolve(input));});}
function reports(output:string,now:number):CaptureEvent[]{
 const path=join(output,'events.sqlite');if(!existsSync(path))return [];
 const db=new DatabaseSync(path,{readOnly:true});
 try{return db.prepare("SELECT payload FROM events WHERE observed_at>=? AND json_extract(payload,'$.source')='agent_report' ORDER BY observed_at DESC LIMIT 2000").all(now-12*3600).map(row=>JSON.parse(String(row.payload)) as CaptureEvent);}
 finally{db.close();}
}
async function main(){
 const [output,ledgerPath,targetId]=process.argv.slice(2);
 if(!output||!ledgerPath||!targetId)return;
 const input=await readInput();let sessionId='';
 try{const value=JSON.parse(input) as {session_id?:unknown};if(typeof value.session_id==='string')sessionId=value.session_id;}catch{/* Claude may send an incomplete payload while closing. */}
 let previous='';
 try{
  const records=JSON.parse(readFileSync(ledgerPath,'utf8')) as Record<string,{previous?:{command?:string}}>;
  const command=records[targetId]?.previous?.command;
  if(typeof command==='string'&&command.length<=8192){const run=spawnSync('/bin/sh',['-c',command],{input,encoding:'utf8',timeout:2000,maxBuffer:16_384,env:process.env});previous=run.stdout?.trimEnd()||'';}
 }catch{/* Keep Agent Time's own line available if the previous command fails. */}
 let own='';try{if(sessionId)own=renderClaudeReportedStatus(reports(output,Date.now()/1000),sessionId,Date.now()/1000);}catch{/* Status line must never interrupt Claude. */}
 const lines=[previous,own].filter(Boolean);if(lines.length)process.stdout.write(lines.join('\n')+'\n');
}
void main();
