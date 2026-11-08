# Efficient long-term history

## Intent and authority

The user approved all audited improvements: unchanged timing computation with less RAM and disk use over years. Prior session authorization covers implementation, verification, publication and reversible operations without repeated confirmation. No unique historical evidence is expired by this design.

## Invariants

- Every logical event retains its exact original payload bytes, event ID, observed timestamp and insertion order. Timing, attribution, health, MCP evidence, reviews, undo and archives see the same logical events.
- Completed tool boundaries may share one physical `tool_call` record; both original boundaries remain independently addressable. Ambiguous, missing-ID, unmatched or clock-reversed pairs remain ordinary evidence.
- Activity contexts and unchanged non-fresh worker observations may share physical records; every timestamp, idle value, collector epoch, gap and source ID remains recoverable.
- Timing reducers and idle-threshold computation do not change. Storage-only settings must not introduce capture-setting fences.
- Schema upgrades happen on a verified copy and use the existing closed-database replacement/rollback mechanism. Running capture is not migrated in place.
- No archive containing unique or unverified evidence/review data is automatically deleted. Manual and unclassified exports remain user-managed.

## Format and compatibility

Introduce format 2, with legacy format 0/1 still readable. All production Node SQLite readers open through `openEventDatabase(path, options)` before any schema query. It registers deterministic `at_event_payload`, sets bounded SQLite caches and rejects unsupported newer formats.

Format 2 `events` has `rowid INTEGER PRIMARY KEY`, `event_id TEXT UNIQUE NOT NULL`, `observed_at REAL NOT NULL`, `payload_data` (raw UTF-8 JSON text or a 36-byte block locator), and generated `payload TEXT` exposing the original JSON. Generated STORED `source`, `accessibility_trusted`, `activity_sample` and `payload_bytes` keep accounting and metadata-only scans cheap. The explicit `rowid` preserves original stable insertion positions. Sparse session-end, resource and coverage indexes avoid decoding unrelated history. Existing JSON-expression indexes and read queries continue to work. Inserts name columns explicitly, with a legacy-aware write helper.

The locator contains a two-byte magic/version, SHA-256 of the compressed block (32 bytes), and a two-byte slot. `at_event_blocks` is content-addressed by SHA-256 and immutable; lookups search main/attached schemas. This makes attached archive decoding safe even when two histories have different block allocation order. Decoder caches are connection-bounded and clear on close. Integrity verification explicitly reads and hashes blocks, bypassing cached results.

`at_tool_keys(rowid PRIMARY KEY, identity BLOB, phase)` supports incremental reconciliation. Identity is SHA-256 of provider/host/session/agent/tool ID; full identities are also compared before pairing. Only one start and one end with complete identifiers and non-reversed timestamps can consolidate. Appended duplicate boundaries never change the decoded evidence of an earlier packed pair. Existing source event IDs remain SQLite keys.

A block codec stores raw fallbacks plus shared-context records (tool_call, activity, worker observations). Canonical JSON uses ordered root/data shapes, common values and per-event deltas. Noncanonical or unusual JSON stays a raw string. Decoding reconstructs exact original JSON, not merely equivalent objects. Slots restore original insertion ranks independently of physical record grouping.

Format 2 requires the new reader. Older readers fail closed because they lack the generated-column decoder; they must not silently see only recent history. Connected agent tools may need a one-time reconnect after optimization. The verified pre-upgrade SQLite archive remains restorable with the new app; decompressing it restores the exact old-format bytes for an older app. Hook writers continue using the stable JSON spool and do not depend on the database format.

## Bounds (implementation defaults)

- Hot age: seven days. Hot raw payload budget: 128 MiB; older data is packed sooner when necessary.
- Blocks: at most 2,048 events and 2 MiB original UTF-8 payload. Encoded gzip input/output expansion limit: 4 MiB. Oversized legacy rows remain raw and are reported, not discarded.
- Decoded payload cache: 16 MiB estimated retained memory per connection. SQLite cache: 8 MiB, temp storage FILE, mmap disabled.
- Day-summary cache: 32 MiB estimated retained memory and at most 16 days. A single oversized requested day may stand alone; ordinary app memory depends on the requested window, not lifetime history. Whole-history responses are not cached above this budget.
- Background care: first check 30 seconds after capture starts, then every 60 seconds; at most 20,480 events / 16 MiB original data per packing pass. Operations run in the existing storage worker/exclusive task slot.
- New spool writes: at most 64 KiB each and 4,096 pending JSON/temp entries, plus concurrent in-flight writes. Enumeration is bounded. A fixed-size overflow marker makes dropped evidence visible; legacy larger queued records can still import. A storage-pause marker prevents further spool growth after a quota stop.
- Managed-storage budget: 5,120 MiB by default, configurable `storageLimitMB` integer 1,024..1,048,576. Reserve at least 1 GiB free disk. Compression, WAL reclamation and verified redundant-backup cleanup precede a quota pause. If they cannot recover space, pause clearly and record a boundary; never fabricate time across a storage stop.
- Automatic rollback target: at most two copies and 512 MiB combined, retaining at least the newest verified copy. Exceptions retain unique/unverified recovery data. Manual/unclassified exports are not auto-deleted. Quota protection covers excess retained files rather than silently deleting them.

## Maintenance and migration

New stores use format 2. Existing stores remain readable until `storage_compact_prepare` prepares an efficient-format candidate through a new lossless optimization path. Preserve the old offline pruning utility for existing tests/explicit use. The new optimization copies, upgrades, packs, verifies ordered logical event hashes and every non-storage table, checks cold blocks/SQLite integrity and vacuums. It preserves all logical rows, so no full-history summary or ordering array is needed for proof.

Live care only runs on format 2, skips pending replacement and runs off the protocol thread. Index newly appended tool boundaries, pack in insertion order and share unique complete pairs within each bounded block alongside activity/worker/raw records. References change atomically with block insertion. Ordinary collection never deletes logical events, so live care does not scan lifetime history for garbage. Verified optimization copies repack sparse blocks in bounded batches and collect unreferenced blocks; the explicit offline pruner also collects unreferenced blocks. Incremental vacuum and passive WAL checkpoints reclaim physical space. Original sequence values never change.

Archives gain `.sqlite.gz` support. Streaming compression writes a private temporary file, verifies decompressed SHA-256/length against the original, atomically publishes it, then removes the redundant plain copy. Restoration decompresses into a private staged SQLite file, validates schema/integrity/logical events and uses the same replacement guards. Pending replacement files are never recompressed. Import/preview support legacy, packed, plain and gzip archives. Archive attachment uses content-addressed block lookup.

Automatic archive retention requires a managed provenance ledger and a full coverage check against current history/reviews before deleting an older automatic rollback. Unclassified existing files are preserved. Failures keep the original and surface storage-care status.

## User experience

Settings → Data & backup shows automatic-care status, actual database/backup/runtime sizes, recent versus compressed payload, savings and configurable storage budget. Explain that full historical detail is retained and that connected tools may need reconnecting after format optimization. Avoid internal codec/schema terminology in the normal flow. Storage-paused state explains the budget/free-space cause and offers a higher budget/export/retry action. No TTL deletion is enabled.

## Validation and release

1. Codec exact round-trips: field order, Unicode, missing/null/false fields, noncanonical JSON, both tool boundaries, activity idle transitions and cross-epoch worker points. Corrupt/bomb/truncated blocks reject within bounds.
2. Legacy/new SQLite query parity including expression indexes, attached archives with colliding local allocation orders, evidence-by-ID and insert/idempotency. Unsupported readers fail visibly.
3. Old/new daily, weekly, whole-summary and MCP outputs match on fixtures with cross-midnight tools, clock rollback, waits, missing/duplicate boundaries, binding changes and review decisions.
4. Crash/retry, busy writer, pending replacement, partial archive, low disk, storage quota and spool overflow paths preserve recoverability and expose uncertainty.
5. Full local suite/build/Rust checks, independent branch review, large copied-database migration under a 128 MiB JS heap with measured RSS/storage and ordered payload hashes, then signed publication and native update/migration/capture checks.

Technical references: https://www.sqlite.org/gencol.html and https://nodejs.org/download/release/v26.12.0/docs/api/sqlite.html. A local Node SQLite probe confirmed generated payloads can decode a block through a deterministic function while maintaining a partial JSON index and passing integrity_check.
