import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { normalizeHook, hookContext, spoolHook } from './hooks.ts';
import { Collector } from './collector.ts';
import { EventStore } from './store.ts';
import { summarize } from './correlate.ts';
import {applyHumanDecisions} from './human-review.ts';
import { renderReport } from './report.ts';
import { dispatchRequest } from './protocol.ts';
import { defaultSettings, storedSettings } from './settings.ts';
import { prepareConfig, applyConfig, restoreConfig, hookEvents } from './hook-config.ts';
import {agentById} from './sources/agent-registry.ts';
import {applyPendingReplacement} from './storage-migration.ts';
const args=process.argv.slice(2),command=args.shift();
if(command==='hook') {
  try{
    const {values}=parseArgs({args,options:{provider:{type:'string'},spool:{type:'string'}},strict:true});
    const chunks:Buffer[]=[];let bytes=0;
    for await(const chunk of process.stdin){bytes+=chunk.length;if(bytes>262144)break;chunks.push(chunk);}
    if(bytes<=262144&&values.provider&&agentById.has(values.provider)&&values.spool)spoolHook(normalizeHook(values.provider,JSON.parse(Buffer.concat(chunks).toString()),hookContext()),values.spool);
  }catch{} // A telemetry hook never blocks or injects context into its agent.
}else{
  try{
    const {values,positionals}=parseArgs({args,allowPositionals:true,options:{output:{type:'string'},database:{type:'string'},duration:{type:'string'},interval:{type:'string'},run:{type:'string'},probe:{type:'string'},keychain:{type:'string'},provider:{type:'string'},config:{type:'string'},manifest:{type:'string'},'hook-command':{type:'string'}}});
    const output=resolve((command==='report'?undefined:values.output)||process.env.ADE_CAPTURE_OUTPUT||'.capture');
    if(command==='report'){
      const database=resolve(values.database||join(output,'events.sqlite')),store=new EventStore(database);
      const settingsPath=join(dirname(database),'settings.json'),settings=existsSync(settingsPath)?storedSettings(JSON.parse(readFileSync(settingsPath,'utf8'))):defaultSettings;
      const target=resolve(values.output||'.capture/report.html');mkdirSync(resolve(target,'..'),{recursive:true});
      writeFileSync(target,renderReport(applyHumanDecisions(summarize(store.events(),{idleThreshold:settings.humanIdleMinutes*60,agentIdleThreshold:settings.agentIdleMinutes*60}),store.humanDecisions()),[]),{mode:0o600});store.close();console.log(target);
    }else if(command==='hook-config'){
      if(!values.manifest)throw new Error('--manifest is required');
      if(positionals[0]==='prepare'){
        if(!values.config||!values.provider||!values['hook-command'])throw new Error('--config, --provider and --hook-command are required');
        const manifest=prepareConfig(resolve(values.config),values.provider,values['hook-command'],hookEvents(values.provider));
        writeFileSync(values.manifest,JSON.stringify(manifest,null,2),{mode:0o600});
      }else{const m=JSON.parse(readFileSync(values.manifest,'utf8'));if(positionals[0]==='apply')applyConfig(m);else if(positionals[0]==='restore')restoreConfig(m);else throw new Error('Unknown hook-config operation');}
    }else if(command==='collect'||command==='protocol'){
      const interval=Number(values.interval||5),duration=Number(values.duration||300);
      if(!Number.isFinite(interval)||interval<1||interval>60||!Number.isFinite(duration)||duration<1||duration>86400)throw new Error('Invalid duration or interval');
      const replacement=applyPendingReplacement(output);
      if(replacement==='stale')console.error('Pending storage replacement was cancelled because tracking data changed');
      const collector=new Collector(output,values.probe||process.env.ADE_ACTIVITY_PROBE||resolve('.capture/bin/activity-probe'),interval,values.run,undefined,values.keychain||resolve('.capture/bin/linear-keychain'));
      let closing=false;async function shutdown(){if(closing)return;closing=true;await collector.close();process.exit(0);}
      process.on('SIGTERM',()=>{void shutdown();});process.on('SIGINT',()=>{void shutdown();});
      if(command==='collect'){await collector.start(duration);console.log(JSON.stringify(collector.status()));setTimeout(()=>{void shutdown();},duration*1000);}
      else{
        const lines=createInterface({input:process.stdin});const pending=new Set<Promise<void>>();
        lines.on('line',line=>{
          const task=(async()=>{if(line.length>65536){console.log(JSON.stringify({id:null,error:'Request too large'}));return;}
            try{console.log(JSON.stringify(await dispatchRequest(JSON.parse(line),collector)));}catch{console.log(JSON.stringify({id:null,error:'Invalid JSON'}));}})();
          pending.add(task);void task.finally(()=>pending.delete(task));
        });
        lines.on('close',()=>{void shutdown();});
      }
    }else throw new Error('Use collect, protocol, hook, hook-config, or report');
  }catch(error){console.error(String(error));process.exitCode=1;}
}
