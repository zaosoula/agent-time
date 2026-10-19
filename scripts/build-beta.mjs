import {spawnSync,execFileSync} from 'node:child_process';
import {existsSync,mkdtempSync,readdirSync,rmSync,statSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {betaBuildConfig} from './beta-config.mjs';
import {betaBundleEnvironment,notarizeBetaDmg} from './beta-release-steps.mjs';

function run(command,args,options={}){
 const result=spawnSync(command,args,{stdio:'inherit',...options});
 if(result.error)throw result.error;
 if(result.status!==0)throw new Error(`${command} failed with status ${result.status}`);
}
const identities=execFileSync('security',['find-identity','-v','-p','codesigning'],{encoding:'utf8'});
const config=betaBuildConfig(process.env,identities);
if(process.env.APPLE_API_KEY_PATH&&!existsSync(process.env.APPLE_API_KEY_PATH))throw new Error('Notarization API key file is missing');
if(process.env.TAURI_SIGNING_PRIVATE_KEY?.startsWith('/')&&!statSync(process.env.TAURI_SIGNING_PRIVATE_KEY).isFile())throw new Error('Updater private key path is not a file');
const app=resolve('src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Agent Time.app');
const executable=join(app,'Contents/MacOS/agent-time');
const processes=execFileSync('ps',['-axo','command='],{encoding:'utf8'});
if(processes.split('\n').some(command=>command===executable||command.startsWith(`${executable} `)))throw new Error('Quit the beta app before rebuilding its running bundle');
run('npm',['run','sidecars:build']);
run('npm',['run','tauri','--','build','--target','aarch64-apple-darwin','--bundles','app,dmg','--config',JSON.stringify(config)],{env:betaBundleEnvironment(process.env)});
const dir=resolve('src-tauri/target/aarch64-apple-darwin/release/bundle');
const macos=join(dir,'macos'),dmg=join(dir,'dmg');
const one=(folder,suffix)=>{const matches=readdirSync(folder).filter(name=>name.endsWith(suffix));if(matches.length!==1)throw new Error(`Expected one ${suffix} in ${folder}`);return join(folder,matches[0]);};
const archive=one(macos,'.app.tar.gz'),signature=`${archive}.sig`,container=one(dmg,'.dmg');
if(!existsSync(signature))throw new Error('Signed updater archive is missing its .sig file');
console.log('Notarizing and stapling the DMG...');
notarizeBetaDmg(container,process.env);
const minimum=config.bundle.macOS.minimumSystemVersion;
const declared=execFileSync('plutil',['-extract','LSMinimumSystemVersion','raw','-o','-',join(app,'Contents/Info.plist')],{encoding:'utf8'}).trim();
if(declared!==minimum)throw new Error(`Bundle minimum macOS version ${declared} does not match ${minimum}`);
const later=(left,right)=>{const a=left.split('.').map(Number),b=right.split('.').map(Number);return a.some((value,index)=>value>(b[index]||0)&&a.slice(0,index).every((part,i)=>part===(b[i]||0)));};
const inspectSignature=file=>{
 const inspected=spawnSync('codesign',['-dv','--verbose=4',file],{encoding:'utf8'});
 if(inspected.status!==0)throw new Error(`Could not inspect signature: ${file}`);
 return inspected.stdout+inspected.stderr;
};
const inspectEntitlements=(file,team,widget=false)=>{
 const inspected=spawnSync('codesign',['-d','--entitlements',':-',file],{encoding:'utf8'});
 const output=inspected.stdout+inspected.stderr;
 const start=output.indexOf('<plist'),end=output.indexOf('</plist>');
 if(inspected.status!==0||start<0||end<start)throw new Error(`Could not inspect entitlements: ${file}`);
 const parsed=spawnSync('plutil',['-convert','json','-o','-','-'],{input:output.slice(start,end+'</plist>'.length),encoding:'utf8'});
 if(parsed.status!==0)throw new Error(`Could not parse entitlements: ${file}`);
 const entitlements=JSON.parse(parsed.stdout);
 const group=entitlements['com.apple.security.application-groups'];
 if(!Array.isArray(group)||group.length!==1||group[0]!==`${team}.studio.ezyo.agenttime`)throw new Error(`Widget app group mismatch: ${file}`);
 const expected=widget?['com.apple.security.app-sandbox','com.apple.security.application-groups']:['com.apple.security.cs.allow-jit','com.apple.security.application-groups'];
 if(Object.keys(entitlements).length!==2||expected.some(key=>entitlements[key]===undefined)||entitlements[widget?'com.apple.security.app-sandbox':'com.apple.security.cs.allow-jit']!==true)throw new Error(`Unexpected entitlement requires release review: ${file}`);
};
run('codesign',['--verify','--deep','--strict','--verbose=2',app]);
const appDetails=inspectSignature(app),team=appDetails.match(/TeamIdentifier=([^\s]+)/)?.[1];
if(!team||!appDetails.includes('flags=')||!appDetails.includes('runtime')||!appDetails.includes('Authority=Developer ID Application:'))throw new Error('App lacks a Developer ID Hardened Runtime signature');
inspectEntitlements(app,team);
const widget=join(app,'Contents/PlugIns/AgentTimeWidget.appex');
const widgetExecutable=join(widget,'Contents/MacOS/AgentTimeWidget');
if(!existsSync(widgetExecutable))throw new Error('Widget extension missing from the app bundle');
run('codesign',['--verify','--strict','--verbose=2',widget]);
const widgetInfo=join(widget,'Contents/Info.plist');
const appInfo=join(app,'Contents/Info.plist');
const plistValue=(info,key)=>execFileSync('plutil',['-extract',key,'raw','-o','-',info],{encoding:'utf8'}).trim();
for(const [key,expected] of [
 ['CFBundleIdentifier','studio.ezyo.agenttime.widget'],
 ['CFBundleShortVersionString',plistValue(appInfo,'CFBundleShortVersionString')],
 ['CFBundleVersion',plistValue(appInfo,'CFBundleVersion')],
 ['NSExtension.NSExtensionPointIdentifier','com.apple.widgetkit-extension'],
 ['LSMinimumSystemVersion',minimum],
]){
 const actual=plistValue(widgetInfo,key);
 if(actual!==expected)throw new Error(`Widget ${key} mismatch: ${actual}`);
}
const archiveEntries=execFileSync('tar',['-tzf',archive],{encoding:'utf8'}).split('\n');
for(const suffix of [
 '/Contents/PlugIns/AgentTimeWidget.appex/Contents/MacOS/AgentTimeWidget',
 '/Contents/MacOS/widget-snapshot',
 '/Contents/Resources/icon.icns',
])if(!archiveEntries.some(entry=>entry.endsWith(suffix)))throw new Error(`Updater archive is missing ${suffix}`);
const bundledFiles=[];
function visit(folder){for(const entry of readdirSync(folder,{withFileTypes:true})){
 const path=join(folder,entry.name);
 if(entry.isDirectory())visit(path);else if(entry.isFile())bundledFiles.push(path);
}}
visit(app);
const machos=bundledFiles.filter(file=>execFileSync('file',['-b',file],{encoding:'utf8'}).includes('Mach-O'));
for(const name of ['agent-time','node','agent-activity','linear-keychain','startup-item','widget-snapshot'])if(!machos.includes(join(app,'Contents/MacOS',name)))throw new Error(`Required bundled executable missing: ${name}`);
if(!machos.includes(widgetExecutable))throw new Error('Widget executable is not Mach-O');
for(const file of machos){
 run('codesign',['--verify','--strict','--verbose=2',file]);
 const details=inspectSignature(file);
 if(!details.includes('Authority=Developer ID Application:')||!details.includes(`TeamIdentifier=${team}`))throw new Error(`Nested code has a different signing identity: ${file}`);
 const kind=execFileSync('file',['-b',file],{encoding:'utf8'});
 if(kind.includes('executable')&&(!details.includes('flags=')||!details.includes('runtime')))throw new Error(`Nested executable lacks Hardened Runtime: ${file}`);
 inspectEntitlements(file,team,file===widgetExecutable);
 const build=execFileSync('xcrun',['vtool','-show-build',file],{encoding:'utf8'});
 const minos=build.match(/minos\s+([\d.]+)/)?.[1];
 if(!minos||later(minos,minimum))throw new Error(`Bundled executable requires macOS ${minos||'unknown'}, above the bundle minimum ${minimum}: ${file}`);
}
const smokeHome=mkdtempSync(join(tmpdir(),'agent-time-beta-smoke-'));
try{
 const collector=spawnSync(join(app,'Contents/MacOS/node'),[join(app,'Contents/Resources/capture/cli.ts'),'protocol','--output',join(smokeHome,'capture'),'--probe',join(app,'Contents/MacOS/agent-activity'),'--keychain',join(app,'Contents/MacOS/linear-keychain')],{input:'{"id":"smoke","method":"status","params":{}}\n',encoding:'utf8',timeout:15000,env:{...process.env,HOME:smokeHome}});
 let reply;try{reply=JSON.parse(collector.stdout.trim());}catch{}
 if(collector.status!==0||reply?.id!=='smoke'||reply?.result?.surfaces?.macosActivity!==true)throw new Error(`Bundled collector could not start: ${collector.stderr.slice(0,1000)}`);
}finally{rmSync(smokeHome,{recursive:true,force:true});}
run('xcrun',['stapler','validate',app]);run('xcrun',['stapler','validate',container]);
run('spctl',['--assess','--type','execute','--verbose=4',app]);
run('shasum',['-a','256',container,archive]);
console.log('Beta candidate verified locally; clean-machine quarantine and update tests remain required.');
