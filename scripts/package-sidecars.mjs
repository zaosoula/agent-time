import { mkdirSync, copyFileSync, cpSync, writeFileSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const target=execFileSync('rustc',['-vV'],{encoding:'utf8'}).match(/^host: (.+)$/m)[1];
// Bundled Node requires macOS 13.5. Keep Swift helpers at the same deployment
// floor instead of inheriting the release machine's current macOS version.
const swiftTarget=`${process.arch==='arm64'?'arm64':'x86_64'}-apple-macos13.5`;
mkdirSync('src-tauri/binaries',{recursive:true});mkdirSync('src-tauri/resources',{recursive:true});mkdirSync('.capture/bin',{recursive:true});
copyFileSync(process.execPath,`src-tauri/binaries/node-${target}`);chmodSync(`src-tauri/binaries/node-${target}`,0o755);
execFileSync('swiftc',['-target',swiftTarget,'native/ActivityProbe.swift','-o','.capture/bin/activity-probe'],{stdio:'inherit'});
copyFileSync('.capture/bin/activity-probe',`src-tauri/binaries/agent-activity-${target}`);
execFileSync('swiftc',['-target',swiftTarget,'native/LinearKeychain.swift','-o','.capture/bin/linear-keychain'],{stdio:'inherit'});
copyFileSync('.capture/bin/linear-keychain',`src-tauri/binaries/linear-keychain-${target}`);
execFileSync('swiftc',['-target',swiftTarget,'native/StartupItem.swift','-o','.capture/bin/startup-item'],{stdio:'inherit'});
copyFileSync('.capture/bin/startup-item',`src-tauri/binaries/startup-item-${target}`);
cpSync('src/usage','src-tauri/resources/usage',{recursive:true});writeFileSync('src-tauri/resources/usage/package.json','{"type":"module"}\n');
cpSync('src/capture','src-tauri/resources/capture',{recursive:true});writeFileSync('src-tauri/resources/capture/package.json','{"type":"module"}\n');
console.log(`Prepared Node ${process.version} and macOS helper for ${target}`);
