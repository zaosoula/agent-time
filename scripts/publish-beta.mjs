import {copyFileSync,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {basename,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {makeBetaManifest} from './beta-manifest.mjs';

export function stageBetaRelease({version,archive,signaturePath,notes,archiveUrl,output}){
 const name=basename(archive),url=new URL(archiveUrl);
 if(decodeURIComponent(url.pathname.split('/').at(-1)||'')!==name)throw new Error('Archive URL does not match the signed archive');
 const signature=readFileSync(signaturePath,'utf8');
 const manifest=makeBetaManifest({version,notes,url:archiveUrl,signature});
 const root=resolve(output),versionDir=join(root,version);
 mkdirSync(root,{recursive:true});
 if(existsSync(versionDir))throw new Error(`Version already exists: ${version}`);
 if(existsSync(join(root,'latest.json.candidate')))throw new Error('Another candidate manifest already exists');
 mkdirSync(versionDir);
 copyFileSync(archive,join(versionDir,name));
 copyFileSync(signaturePath,join(versionDir,name+'.sig'));
 const digest=createHash('sha256').update(readFileSync(archive)).digest('hex');
 writeFileSync(join(versionDir,'SHA256SUMS'),`${digest}  ${name}\n`,{flag:'wx'});
 writeFileSync(join(versionDir,'release-notes.md'),notes,{flag:'wx'});
 writeFileSync(join(root,'latest.json.candidate'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [archive,signaturePath,archiveUrl,output,notesFile]=process.argv.slice(2);
 if(!archive||!signaturePath||!archiveUrl||!output||!notesFile)throw new Error('Usage: node scripts/publish-beta.mjs ARCHIVE SIGNATURE HTTPS_ARCHIVE_URL OUTPUT_DIR NOTES_FILE');
 const packageJson=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8'));
 stageBetaRelease({version:packageJson.version,archive,signaturePath,archiveUrl,output,notes:readFileSync(notesFile,'utf8')});
 console.log('Candidate staged locally. Validate hosted archive and approval gates before promoting latest.json.candidate to latest.json.');
}
