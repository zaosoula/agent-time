import { mkdirSync, copyFileSync as copyInPlace, cpSync, writeFileSync, chmodSync, readFileSync, rmSync } from 'node:fs';
// Overwriting a signed Mach-O in place leaves macOS's cached code signature
// stale, and the kernel then kills the new binary (exit 137). Replace it.
const copyFileSync=(source,target)=>{rmSync(target,{force:true});copyInPlace(source,target);};
import { execFileSync } from 'node:child_process';
import { checkBundledNode } from './node-runtime.mjs';
// The running Node binary is copied into the app. Refuse one that does not
// match the supported engine or links non-system libraries (e.g. Homebrew's
// shared libnode/ICU), which would fail on machines without them.
const engines=JSON.parse(readFileSync('package.json','utf8')).engines?.node;
const nodeProblems=checkBundledNode({version:process.versions.node,engines,arch:process.arch,libraries:execFileSync('otool',['-L',process.execPath],{encoding:'utf8'})});
if(nodeProblems.length){
 const message=`Cannot bundle ${process.execPath} (Node ${process.version}):\n - ${nodeProblems.join('\n - ')}`;
 if(process.env.AGENT_TIME_ALLOW_NODE==='1')console.warn(`warning: ${message}`);
 else throw new Error(`${message}\nInstall the official Node build for this version, or set AGENT_TIME_ALLOW_NODE=1 to override.`);
}
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
execFileSync('swiftc',['-target',swiftTarget,'native/widget/Snapshot.swift','native/WidgetSnapshot.swift','-o','.capture/bin/widget-snapshot'],{stdio:'inherit'});
copyFileSync('.capture/bin/widget-snapshot',`src-tauri/binaries/widget-snapshot-${target}`);
execFileSync('node',['scripts/build-widget.mjs'],{stdio:'inherit',env:process.env});
cpSync('src/usage','src-tauri/resources/usage',{recursive:true});writeFileSync('src-tauri/resources/usage/package.json','{"type":"module"}\n');
cpSync('src/capture','src-tauri/resources/capture',{recursive:true});writeFileSync('src-tauri/resources/capture/package.json','{"type":"module"}\n');
cpSync('src/mcp','src-tauri/resources/mcp',{recursive:true});writeFileSync('src-tauri/resources/mcp/package.json','{"type":"module"}\n');
mkdirSync('src-tauri/resources/node_modules/@modelcontextprotocol',{recursive:true});
for(const name of ['server','core'])cpSync(`node_modules/@modelcontextprotocol/${name}`,`src-tauri/resources/node_modules/@modelcontextprotocol/${name}`,{recursive:true});
cpSync('node_modules/zod','src-tauri/resources/node_modules/zod',{recursive:true});
console.log(`Prepared Node ${process.version} and macOS helper for ${target}`);
