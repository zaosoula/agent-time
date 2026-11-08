# Efficient History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Preserve all timing/evidence semantics while bounding normal RAM, hot storage, spool growth and automatic backups.
**Architecture:** A lossless packed-event codec and content-addressed SQLite payload layer keep existing logical queries intact. Copy-based upgrade enables bounded background packing; gzip archives and quota protection manage long-term disk use.
**Tech Stack:** TypeScript, Node 26 built-in SQLite/crypto/zlib/streams, Vue, existing Rust Tauri bridge; no added dependencies.
**Spec:** `docs/superpowers/specs/2026-11-08-efficient-history-design.md`

## Global Constraints

Exact original payload bytes, event IDs, timestamps and insertion sequence must round-trip. No timing-reducer changes. Blocks ≤2,048 events /2 MiB original /4 MiB codec output; decode cache16 MiB; SQLite cache8 MiB; summary cache32 MiB /16 days. Hot7 days /128 MiB. Background30 seconds then60 seconds; pass20,480 rows /16 MiB. Default managed budget5,120 MiB, range1,024..1,048,576; free reserve1 GiB. Spool64 KiB /4,096 entries. Automatic rollback target2 /512 MiB, with unique/unverified/manual data protected. Never touch live data until copied-database parity passes.

## Review Focus

- Raw/noncanonical JSON and unusual imported metadata reconstruct byte-for-byte, including ordering.
- Two attached archives cannot decode the wrong block even if their local allocation order differs.
- Late duplicate tool boundaries and calls crossing packing batches retain original evidence semantics.
- Pending replacements, busy writers and archive/packing crashes never publish partial data or delete the original.
- Quota-only setting changes introduce no timing fence; quota pauses and overflow expose unknown evidence rather than silently losing it.

---

### Task 1: Lossless shared-record codec
**Files:** create `src/capture/packed-codec.ts`, `tests/packed-codec.test.ts`.
**Interfaces:** `encodeEventBlock(payloads:string[], toolPairs?:Array<[number,number]>):{data:Buffer;key:string;originalBytes:number;count:number;records:{toolCalls:number;activityRuns:number;workerRuns:number}}`; `decodeEventBlock(data:Uint8Array,expectedKey:string):string[]`. Export fixed bounds.
- [x] Write exact raw-string round-trip tests for canonical/Unicode/noncanonical/null payloads, call common/different fields, shuffled slots, activity idle/permission changes and multi-epoch workers. Assert one physical call record and original two boundary strings.
- [x] Run `node --test tests/packed-codec.test.ts`; expected FAIL missing module, then specific bound/corruption assertions.
- [x] Implement bounded versioned gzip codec, shared ordered shapes/context and raw fallback; validate hash/count/slots/expanded bytes.
- [x] Run codec tests; expected all pass. Commit task.

### Task 2: Compatible SQLite format and reader factory
**Files:** create `src/capture/event-database.ts`, `tests/event-database.test.ts`; modify Node DB openings in capture/store/compact/storage/hooks, MCP/data/statusline and usage/reader.
**Interfaces:** `openEventDatabase(path:string,options?:{readOnly?:boolean}):DatabaseSync`; `isPackedEventDatabase(db):boolean`; `createPackedEventSchema(db):void`; `upgradeEventSchema(db):void`; `insertEventRow(db,id,at,payload):boolean`; `verifyPackedBlocks(db):void`; `eventStorageStats(db)`.
- [x] Write failing legacy/new indexed-query, explicit insert, attached-content-address lookup, corrupted block and version-floor tests. Preserve arbitrary original sequence gaps.
- [x] Run `node --test tests/event-database.test.ts`; expected FAIL missing factory.
- [x] Implement generated payload, immutable content-addressed blocks, bounded decoder cache, sequence/metadata columns and shared index creation. Register decoder before querying schema. Wire every production connection, including archive attachments and statusline.
- [x] Update only direct test SQL that writes a new-format store to use explicit writer/factory; leave genuine legacy fixtures unchanged.
- [x] Run factory tests plus `npm test`; expected green legacy/current behavior. Commit task.

### Task 3: Bounded packing and lossless copy upgrade
**Files:** create `src/capture/packed-maintenance.ts`, `src/capture/optimized-copy.ts`, `tests/packed-maintenance.test.ts`, `tests/optimized-copy.test.ts`; modify storage-worker/migration/Collector prepare path.
**Interfaces:** `packEventHistory(db,options:{now:number;hotBytes?:number;hotDays?:number;maxRows?:number;maxBytes?:number}):PackingResult`; `optimizedCaptureCopy(source,target,options?):CompactCopyResult`; new storage task `op:'optimize'|'maintain'`.
- [x] Write failing unique/ambiguous/late/clock-reversed call, context/heartbeat, rollback, busy/retry and exact logical-row hash tests. Assert stable sequences and every boundary lookup.
- [x] Implement incremental tool-key indexing, bounded pair-first blocks and other shared records, atomic refs, garbage collection and incremental vacuum. No logical deletion.
- [x] Implement verified copy conversion preserving all rows/non-storage tables and source stale-hash/owner guards. Keep old explicit pruning function available.
- [x] Run new tests, storage migration and MCP/timing parity tests; expected identical outputs and safe retries. Commit task.

### Task 4: Compressed archives and safe backup retention
**Files:** create `src/capture/archive-storage.ts`, `tests/archive-storage.test.ts`; modify EventStore archive APIs, storage-migration/worker/usage.
**Interfaces:** `compressArchive(path):Promise<{path:string;bytes:number;sha256:string;originalBytes:number}>`; `withReadableArchive<T>(path:string,run:(plainPath:string)=>T|Promise<T>):Promise<T>`; existing plain sync preview/import remain, async wrappers handle gzip; `maintainArchives(root,options):Promise<ArchiveCareResult>`; provenance ledger.
- [x] Write failing gzip exact-byte/integrity/preview/import/restore, interruption/source-change and unique/manual-backup preservation tests.
- [x] Implement streaming verified compression and private staging, gzip ID/path validation, plain/packed compatibility and pending replacement exclusions. Retire only verified redundant automatic backups beyond target.
- [x] Run archive/recovery/export tests; expected original remains on every failure and exact restored bytes. Commit task.

### Task 5: Automatic care, quotas, bounded spool and caches
**Files:** create `src/capture/storage-policy.ts`, tests; modify collector/settings/storage-worker/day-summaries/hooks and Rust settings validation.
**Interfaces:** `storagePolicyDecision({managedBytes,freeBytes},limitMB)`; quick filesystem usage; status storage-care fields; `storageLimitMB` config; bounded spool marker contract.
- [x] Write failing quota-only no-fence, compression-before-pause, reserve/busy/pending, queue overflow/enumeration and cache-eviction equivalence tests.
- [x] Implement scheduled exclusive worker care and persistent storage-pause reason, guards before start/ticks, fixed-size gap notices, pending file limits and bounded directory iteration. Legacy queued records still import.
- [x] Add estimated summary-cache budgeting, avoid retaining oversized whole-history responses, preserve same reducer results.
- [x] Run policy/spool/collector/settings/Rust tests and full suite; expected bounded behavior, exact timings and visible recovery paths. Commit task.

### Task 6: Storage UI and large-database parity
**Files:** modify `src/ui/StorageUsage.vue`, transport/settings bindings; add focused UI contract tests if behavior warrants; update release docs/scripts.
- [x] Add status/budget/optimization behavior tests before implementation; implement plain-language recent/compressed/backup accounting and quota recovery actions.
- [x] On a private consistent copy, run optimization under128 MiB JS heap, verify ordered payload/table hashes, daily/weekly/MCP/review equivalence, decoded cache budget and low-memory capture/maintenance. Compare physical bytes and RSS.
- [x] Run `npm test`, `npm run build`, locked Rust suite. Expected all pass. Commit task.

### Task 7: Independent review, publication and native migration
- [x] Fresh whole-branch review against spec, especially attached archive UDF routing, partial writes and quota fences. Fix Critical/Important findings with RED→GREEN proof and a green suite.
- [x] Integrate clean commits into main without unrelated files. Bump consistent beta version/notes/record, publish signed macos-26 artifact, independently verify public bytes/signing.
- [x] Observe native update, prepare/apply verified efficient-format copy with capture stopped, restart and verify history/review/evidence plus fresh capture and automatic limits. Keep recoverable backup and document old-reader reconnect/rollback.
- [x] Record final source/hashes/test/memory/storage measurements, remove disposable DB copies and finish with actual results/limits.
