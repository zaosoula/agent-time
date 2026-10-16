export interface BetaManifestInput {version:string;notes:string;url:string;signature:string}
export interface BetaManifest {version:string;notes:string;platforms:{'darwin-aarch64':{url:string;signature:string}}}
export function makeBetaManifest(input:BetaManifestInput):BetaManifest;
export function isNewerBetaVersion(next:string,current:string):boolean;
