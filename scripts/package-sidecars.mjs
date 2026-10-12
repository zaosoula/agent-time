import { mkdirSync, copyFileSync, cpSync, writeFileSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const target=execFileSync('rustc',['-vV'],{encoding:'utf8'}).match(/^host: (.+)$/m)[1];
mkdirSync('src-tauri/binaries',{recursive:true});mkdirSync('src-tauri/resources',{recursive:true});mkdirSync('.capture/bin',{recursive:true});
copyFileSync(process.execPath,`src-tauri/binaries/node-${target}`);chmodSync(`src-tauri/binaries/node-${target}`,0o755);
execFileSync('swiftc',['native/ActivityProbe.swift','-o','.capture/bin/activity-probe'],{stdio:'inherit'});
copyFileSync('.capture/bin/activity-probe',`src-tauri/binaries/agent-activity-${target}`);
cpSync('src/capture','src-tauri/resources/capture',{recursive:true});writeFileSync('src-tauri/resources/capture/package.json','{"type":"module"}\n');
console.log(`Prepared Node ${process.version} and macOS helper for ${target}`);
