import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createInvitePageLink} from './server.mjs';

const [version, hoursInput = '168'] = process.argv.slice(2);
const hours = Number(hoursInput);
const keyFile = process.env.INVITE_SIGNING_KEY_FILE;
if (!version || !Number.isSafeInteger(hours) || hours < 1 || hours > 720 || !keyFile) {
  throw new Error('Usage: INVITE_SIGNING_KEY_FILE=/protected/path node beta-feed/create-invite.mjs VERSION [HOURS=168]');
}
const inviteSigningKey = (await readFile(keyFile, 'utf8')).trim();
const expires = Math.floor(Date.now() / 1000) + hours * 3600;
console.log(createInvitePageLink({
  publicOrigin: process.env.PUBLIC_ORIGIN ?? 'https://agent-time.ezyostudio.com',
  inviteSigningKey, version, expires, nonce: randomBytes(16).toString('hex'),
}));
