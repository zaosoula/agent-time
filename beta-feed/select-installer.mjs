import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';

const [version] = process.argv.slice(2);
const tokenFile = process.env.UPLOAD_TOKEN_FILE;
const origin = process.env.UPLOAD_ORIGIN ?? 'https://agent-time-origin.ezyostudio.com';
if (!(version === 'withdraw' || /^\d+\.\d+\.\d+-beta\.\d+$/.test(version ?? '')) || !tokenFile) {
  throw new Error('Usage: UPLOAD_TOKEN_FILE=/protected/path node beta-feed/select-installer.mjs VERSION|withdraw');
}

const token = (await readFile(tokenFile, 'utf8')).trim();
const body = version === 'withdraw' ? null : Buffer.from(version);
const response = await fetch(new URL('/admin/installers/current', origin), {
  method: body ? 'PUT' : 'DELETE',
  headers: {Authorization: `Bearer ${token}`, ...(body ? {'X-Content-SHA256': createHash('sha256').update(body).digest('hex')} : {})},
  ...(body ? {body} : {}),
});
if (response.status !== 204) throw new Error(`Installer selection rejected: HTTP ${response.status}`);
console.log(version === 'withdraw' ? 'Public installer withdrawn' : `Public installer selected: ${version}`);
