import {compactCaptureCopy} from '../src/capture/compact-copy.ts';

const [source,target,...extra]=process.argv.slice(2);
if(!source||!target||extra.length)throw new Error('Usage: node scripts/compact-capture-copy.mjs SOURCE.sqlite OUTPUT.sqlite');
console.log(JSON.stringify(compactCaptureCopy(source,target)));
