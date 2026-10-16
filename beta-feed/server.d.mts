import type {IncomingMessage, ServerResponse} from 'node:http';
export function createBetaFeed(config: {dataDir: string; uploadToken: string; inviteSigningKey: string; publicOrigin: string}): (request: IncomingMessage, response: ServerResponse) => Promise<void>;
export function createInstallLink(config: {publicOrigin: string; inviteSigningKey: string; version: string; expires: number; nonce: string}): string;
export function createInvitePageLink(config: {publicOrigin: string; inviteSigningKey: string; version: string; expires: number; nonce: string}): string;
