import type {DatabaseSync} from 'node:sqlite';

// Browser-safe registry: summary-window is also imported by the web UI. Only
// the Node database factory supplies a reader; no Node runtime code lives here.
const readers=new WeakMap<DatabaseSync,(value:unknown)=>string>();
export function registerPayloadReader(db:DatabaseSync,read:((value:unknown)=>string)|undefined):void{
 if(read)readers.set(db,read);else readers.delete(db);
}
/** Decode a stored locator directly, avoiding a second SQLite/V8 string copy. */
export function readStoredPayload(db:DatabaseSync,locator:unknown):string{
 const read=readers.get(db);if(!read)throw new Error('Event payload reader is unavailable');return read(locator);
}
