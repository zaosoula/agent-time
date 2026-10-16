export function makeBetaManifest({version,notes,url,signature}){
 if(!/^\d+\.\d+\.\d+-beta\.\d+$/.test(version))throw new Error('A monotonically released beta version is required');
 if(typeof signature!=='string'||!signature.trim())throw new Error('The updater signature content is required');
 let location;
 try{location=new URL(url);}catch{throw new Error('An HTTPS update artifact URL is required');}
 if(location.protocol!=='https:'||location.username||location.password||location.hash)throw new Error('An HTTPS update artifact URL without credentials is required');
 return {version,notes:typeof notes==='string'?notes:'',platforms:{'darwin-aarch64':{url:location.href,signature:signature.trim()}}};
}

export function isNewerBetaVersion(next, current){
 const parts=value=>/^(\d+)\.(\d+)\.(\d+)-beta\.(\d+)$/.exec(value)?.slice(1).map(Number);
 const a=parts(next),b=parts(current);
 if(!a||!b)return false;
 for(let i=0;i<a.length;i++)if(a[i]!==b[i])return a[i]>b[i];
 return false;
}
