import type {IncomingMessage, ServerResponse} from 'node:http';
export function createBetaFeed(config: {dataDir: string; uploadToken: string; publicOrigin: string}): (request: IncomingMessage, response: ServerResponse) => Promise<void>;
