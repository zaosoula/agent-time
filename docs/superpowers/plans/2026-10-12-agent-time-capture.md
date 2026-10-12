# Orca Agent Time Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove local capture and correct grouping of human activity, Orca orchestration workers, and provider sessions; display the evidence in a minimal Tauri app and export HTML.

**Architecture:** TypeScript adapters and a Node sidecar own SQLite and deterministic time reduction. A Swift helper supplies macOS signals; a thin Rust/Tauri host manages child processes and restricted IPC. Vue/Reka UI/TypeScript renders summaries without owning capture lifecycle.

**Tech Stack:** Node.js 26.9+, TypeScript, node:sqlite, node:test, Swift/AppKit/CoreGraphics/ApplicationServices, Tauri 2/Rust, Vue 3/Reka UI/Vite. Pin installed dependencies with lockfiles. No Python application code.

**Spec:** `docs/superpowers/specs/2026-10-12-agent-time-capture-design.md` (updated for Node/Tauri).

## Global Constraints

- Use TypeScript on Node.js 26.9+ for CLI orchestration, SQLite persistence through node:sqlite, correlation, replay tests, and reporting.
- Present the validation dashboard using TypeScript, Vue 3, Reka UI, and Vite inside Tauri 2.
- Keep the Rust shell limited to window lifecycle, restricted IPC, and managing the Node/Swift processes.
- Use a small native Swift helper for macOS foreground, input inactivity, and sleep/wake observations.
- Poll documented Orca read APIs at a configurable interval, default five seconds.
- Use a configurable idle threshold, initially five minutes, retaining underlying observations so later correction is possible.
- The collector never consumes or acknowledges an orchestration inbox and never executes suggested next actions.
- Collection failure must not block, interrupt, or add context to an agent.
- Hook installation is explicit and reversible; preserve existing configurations and resolve the actual configuration root for each Orca account before modifying it.
- Folder workspaces are supported without Git.
- Every derived interval carries observed, inferred, or unresolved proof status and its source evidence.
- Store generated evidence and databases outside tracked source paths and keep transcript/prompt content out of fixtures.
- Closing the window hides it while the app process continues collection; explicitly quitting flushes and stops its owned collector/helper.
- Signing/notarization and distribution are outside this phase.
- Defer billing, cloud sync, full application tracking, screenshots/OCR, AI summaries, pricing calculations, and polished dashboard UI.

## Review Focus

1. Several sessions in one directory must remain unresolved without verified terminal/session bindings (Task 3).
2. Clock rollback, collector restarts, and missing observations must never inflate duration (Tasks 1 and 3).
3. Partial pages and remote omissions must be coverage uncertainty, not completion (Task 2).
4. Corrupt/concurrent spool records and configuration rollback must preserve agent execution and unrelated hooks (Task 2).
5. Dashboard reload, window close, and packaged launch must not duplicate collectors or depend silently on development runtimes (Task 5).

## File structure and contracts

Create `src/capture/{events,store,orca,hooks,hook-config,correlate,macos,report,protocol,cli}.ts`, corresponding tests in `tests/`, `native/ActivityProbe.swift`, `src/ui/{App.vue,main.ts,transport.ts}`, `src-tauri/{Cargo.toml,tauri.conf.json,src/main.rs,src/lib.rs}`, `scripts/package-sidecars.mjs`, `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `.gitignore`, `README.md`, and `docs/capture-validation.md`. Keep generated data/build outputs in ignored `.capture/`, `dist/`, `src-tauri/target/`, and generated sidecar directories. Do not commit bundled Node binaries.

Use ESM with NodeNext resolution, strict TypeScript, erasable type syntax, and `.ts` imports for capture code running directly in the pinned Node runtime. Scripts: `typecheck` runs `tsc --noEmit`; `test` runs `node --test tests/*.test.ts`; `capture` runs `node src/capture/cli.ts`; `dev` runs Vite; `tauri` runs the Tauri CLI. TypeScript, Node typings, Vue/Vite, Tauri frontend API and CLI are pinned dependencies; capture imports only Node built-ins. Vite bundles the frontend separately.

Define `CaptureEvent` with required `eventId`, `source`, `kind`, `observedAt` (UTC seconds), `monotonicAt`, `collectorEpoch`, and optional `sourceAt`, `hostId`, `runtimeId`, `workspaceId`, `cwd`, `terminalHandle`, `terminalIncarnation`, `provider`, `sessionId`, `turnId`, `agentId`, `parentAgentId`, `runId`, `taskId`, `dispatchId`, `data`. Payloads are explicitly allowlisted. Require finite timestamps and nonempty IDs; absent identity is never fabricated.

Define `Interval` with `start`, `end`, `state`, `proof`, `sourceEventIds`, and optional grouping identities. Define `Summary` with `intervals`, `unresolved`, `coverage`, `humanSeconds`, `agentSeconds`, `elapsedSeconds`, `childAgentSeconds`. Root inclusive time and child detail remain separate. Define `Verdict` with `scenario`, `mode` (live/simulated), `status` (pass/fail/unsupported/unverified), and `evidence`.

## Task 1: Event storage and replay

**Files:** events/store modules, `tests/store.test.ts`, package/TS configuration, `.gitignore`.

**Interfaces:** `makeEvent(source: string, kind: string, fields: Partial<CaptureEvent>): CaptureEvent`; `EventStore(path: string)` with `put(event): boolean`, `events(): CaptureEvent[]`, `close(): void`.

- [ ] Write failing tests for idempotent persistence, conflicting IDs, invalid timestamps, private file modes, and monotonic ordering across epochs. Include:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventStore } from '../src/capture/store.ts';
test('event replay is idempotent', () => {
  const store = new EventStore(':memory:');
  const event = { eventId: 'e1', source: 'test', kind: 'running',
    observedAt: 10, monotonicAt: 1, collectorEpoch: 'a' };
  assert.equal(store.put(event), true);
  assert.equal(store.put(event), false);
  assert.deepEqual(store.events(), [event]);
  store.close();
});
```

- [ ] Run red with `node --test tests/store.test.ts`; expect missing module before implementation.
- [ ] Implement validation and SQLite transactions using `DatabaseSync` from `node:sqlite`, a primary key on `event_id`, and prepared parameterized statements. Compare duplicate payloads before returning false. Preserve timestamps rather than rewriting clock rollback. Create private directories before the SQLite file; expose deterministic replay ordering.

```typescript
const db = new DatabaseSync(path);
db.exec('PRAGMA journal_mode=WAL');
db.exec('CREATE TABLE IF NOT EXISTS events '
  + '(event_id TEXT PRIMARY KEY, observed_at REAL NOT NULL, payload TEXT NOT NULL)');
const insert = db.prepare('INSERT INTO events VALUES (?, ?, ?)');
insert.run(event.eventId, event.observedAt, JSON.stringify(event));
```

- [ ] Run green: `node --test tests/store.test.ts`, `npm run typecheck`, `git diff --check`.
- [ ] Commit only Task 1 paths as `feat: persist capture events idempotently`.

## Task 2: Orca and hook ingestion

**Files:** orca/hooks/hook-config modules, `tests/ingestion.test.ts`, `tests/hook-config.test.ts`.

**Interfaces:** `readWorkers(call: (argv: string[]) => Promise<unknown>, runId?: string): Promise<{workers: unknown[]; coverage: unknown[]}>`; `normalizeHook(provider: string, payload: unknown, context: Partial<CaptureEvent>): CaptureEvent`; `spoolHook(event: CaptureEvent, directory: string): boolean`; `importSpool(directory: string, store: EventStore): unknown[]`; `prepareConfig(path: string, provider: string, command: string, events: string[]): object`; `restoreConfig(manifest: object): void`. Define and validate typed receipt/config manifests inside the owning modules, narrowing unknown before use.

- [ ] Write failing pagination, receipt validation, corrupt spool, privacy and rollback tests. Include:

```typescript
const pages = [
  { ok: true, result: { workers: [{ dispatchId: 'd1' }],
    page: { hasMore: true, nextCursor: 'page-2' } } },
  { ok: true, result: { workers: [{ dispatchId: 'd2' }],
    page: { hasMore: false } } },
];
const calls: string[][] = [];
const result = await readWorkers(async argv => {
  calls.push(argv); return pages.shift();
}, 'r1');
assert.equal(result.workers.length, 2);
assert.ok(calls[1].includes('page-2'));
assert.deepEqual(result.coverage, []);
```

Test repeated/missing cursor, timeout after a page, omitted hosts, vanished workers, invalid receipts, missing optional provider data, incomplete files, concurrent unique record writes, oversized input, prompt/output removal, and exact duplicate imports. Test hook failures return 0 with empty output. Test config rollback preserves unrelated concurrent additions and refuses destructive conflicts/symlinks.
- [ ] Run red with `node --test tests/ingestion.test.ts tests/hook-config.test.ts`.
- [ ] Implement read-only argv execution through `spawn`/`execFile` with bounded timeout and output; validate installed command help before relying on flags. Fully traverse worker pagination and preserve runtime/host evidence.

```typescript
const argv = ['orchestration', 'worker-list', '--limit', '100', '--json'];
if (runId) argv.push('--run', runId);
if (cursor) argv.push('--cursor', cursor);
```

Normalize worker/terminal identities, fresh/stale state and settled outcomes. Never consume inboxes or execute projected next actions. Hooks accept at most 256 KiB, write a UUID-named atomic spool record, and exit silently with success on capture failure. Import final records only; remove them only after committed storage. No network or Orca calls from hook scripts.

Fetch current official hook docs during execution; discover actual provider executable/account config roots without exposing secrets. Add supported lifecycle hooks using reversible manifests; preserve existing hooks and require the provider's normal trust flow, never a bypass. Inspect only allowlisted identity variables/process ancestry to prove terminal/session joins. Unsupported events become capability verdicts. Native subagent IDs remain distinct even when a root session ID is shared.
- [ ] Run green for these tests plus typecheck; commit Task 2 paths as `feat: ingest Orca metadata and agent hooks`.

## Task 3: Session grouping and bounded time

**Files:** correlate module and `tests/correlate.test.ts`.

**Interfaces:** `unionSeconds(intervals: Array<[number, number]>): number`; `summarize(events: CaptureEvent[], options?: {idleThreshold?: number; maxGap?: number}): Summary`, defaults 300/15 seconds. Explicit verified binding events have session, host, terminal/incarnation, and validity boundaries in data.

- [ ] Write failing tests including:

```typescript
assert.equal(unionSeconds([[0, 60], [20, 80]]), 80);
assert.equal(unionSeconds([[0, 60], [60, 90]]), 90);
const result = summarize([{ eventId: 'h1', source: 'hook',
  kind: 'prompt_submitted', observedAt: 10, monotonicAt: 1,
  collectorEpoch: 'a', sessionId: 's1', cwd: '/shared' }]);
assert.ok(result.unresolved.length > 0);
assert.equal(result.agentSeconds, 0);
```

Add fixtures covering two Runs sharing a workspace; follow-up/retry in reused terminal; completed retained worker; user takeover; missing stop; known wait/resume; root/child overlap; parallel independent roots; duplicate/out-of-order events; backwards clock; collector restart; sleep; observation gaps; foreground overlap and reading/idle estimates. Every synthetic fixture is labeled simulated.
- [ ] Run red with `node --test tests/correlate.test.ts`.
- [ ] Implement overlap merging:

```typescript
const merged: Array<[number, number]> = [];
for (const [start, end] of [...intervals].sort((a,b) => a[0]-b[0])) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
    throw new Error('invalid interval');
  const last = merged.at(-1);
  if (last && start <= last[1]) last[1] = Math.max(last[1], end);
  else merged.push([start, end]);
}
return merged.reduce((sum, [start,end]) => sum + end-start, 0);
```

Keep Run/Task/Dispatch ownership time-bounded. Directory alone cannot join a session; unmatched evidence remains unresolved. Submission means pending, not execution; fresh activity/tool evidence opens bounded segments. Response Stop closes a turn segment, accepted settlement closes attempt ownership, and continuation opens another segment. Gaps, stale status, remote loss and retained terminal lifetime never extend duration indefinitely. Preserve timing uncertainty/source IDs. Sum independent roots but keep native children separate from inclusive parent totals. Count human/project elapsed overlaps once.
- [ ] Run green and typecheck; commit Task 3 paths as `feat: group sessions and calculate bounded time`.

## Task 4: macOS activity helper

**Files:** Swift helper, macos module, `tests/macos.test.ts`.

**Interfaces:** helper emits JSON lines for foreground, idle, capabilities and sleep/wake; `normalizeActivity(payload: unknown, context: Partial<CaptureEvent>): CaptureEvent`; `probeCapabilities(executable: string): Promise<object>`.

- [ ] Write failing tests: negative/nonfinite or uptime-exceeding idle becomes unknown; missing permission does not break app-level capture; sleep/wake breaks continuity; focused app without session identity stays unassigned. Include:

```typescript
const event = normalizeActivity({ foregroundBundleId: 'test.app',
  idleSeconds: -1, observedAt: 10, monotonicAt: 1 },
  { collectorEpoch: 'a', hostId: 'local' });
assert.equal(event.data?.idleSeconds, null);
assert.equal(event.data?.idleStatus, 'unknown');
```

- [ ] Run red with `node --test tests/macos.test.ts`.
- [ ] Implement native API anchors and notification observers:

```swift
let app = NSWorkspace.shared.frontmostApplication
let allEvents = CGEventType(rawValue: UInt32.max)!
let idle = CGEventSource.secondsSinceLastEventType(
    .combinedSessionState, eventType: allEvents)
let trusted = AXIsProcessTrusted()
```

Emit flushed JSON lines, validate against uptime, observe foreground/sleep/wake, and inspect only focused-window/selected workspace identifiers if Accessibility is available. Do not dump full UI trees, capture typed text, or silently request permission. Check trust for the actual helper, not a previous Swift process.
- [ ] Build with `swiftc native/ActivityProbe.swift -o .capture/bin/activity-probe` after creating the output directory. Run a bounded foreground/idle sample and record permission and focused-session capability honestly.
- [ ] Run green/typecheck; commit Task 4 paths as `feat: capture macOS foreground and idle signals`.

## Task 5: Tauri validation dashboard and live proof

**Files:** CLI/protocol/report modules, UI/Tauri/package-sidecar files, `tests/protocol.test.ts`, `tests/report.test.ts`, `tests/cli.test.ts`, README and validation document.

**Interfaces:** `renderReport(summary: Summary, verdicts: Verdict[]): string`; UI `CaptureTransport` offers `status(): Promise<object>`, `summary(): Promise<Summary>`, `start(durationSeconds: number): Promise<object>`, `stop(): Promise<object>`. JSON-lines requests have `id`, allowlisted `method`, and typed params; replies have matching `id`, `result` or `error`. Rust custom commands expose only these methods, with finite bounds validation and request deadlines. One host-owned collector, one helper, one SQLite writer.

- [ ] Write failing tests for protocol readiness/timeouts/crashes, unknown methods, arbitrary executable/path rejection, collector reuse, report escaping, simulated/live evidence separation, and silent hook failure. Include:

```typescript
const summary: Summary = { intervals: [], unresolved: [], coverage: [],
  humanSeconds: 0, agentSeconds: 0, elapsedSeconds: 0, childAgentSeconds: 0 };
const rendered = renderReport(summary, [{ scenario: '<script>alert(1)</script>',
  mode: 'live', status: 'unverified', evidence: 'no verified binding' }]);
assert.ok(!rendered.includes('<script>alert(1)</script>'));
assert.ok(rendered.includes('&lt;script&gt;'));
assert.ok(rendered.includes('unverified'));
```

- [ ] Run red for protocol/report/CLI tests.
- [ ] Implement bounded CLI capture, spool imports, report export, config manifest operations and protocol dispatcher. Separate stdout protocol from stderr diagnostics. Shutdown flushes and terminates only owned children; failures preserve collected events. Use the existing storage/reducer contracts:

```typescript
const store = new EventStore(databasePath);
const summary = summarize(store.events(), { idleThreshold: 300, maxGap: 15 });
writeFileSync(reportPath, renderReport(summary, verdicts), 'utf8');
store.close();
```

- [ ] Add minimal Vue report window: workspace/Run/task/session tree, human/agent/elapsed totals, native child detail, interval evidence, ten-scenario verdict table, status and bounded capture controls. Use Vue text interpolation, never untrusted `v-html`. Plain readable layout; no billing or polished product scope.
- [ ] Implement thin Rust host: spawn approved bundled executables with fixed argv; multiplex request IDs; apply deadlines; expose only narrow commands; reject arbitrary commands/paths. No frontend shell permissions. Readiness/reload/second-window reuses the existing process. Close hides the window; explicit Quit shuts children down. A browser preview uses a labeled test transport, not fake live proof.
- [ ] Bundle pinned Node runtime plus capture resources and compiled Swift helper using Tauri resource/external binary configuration. Generate correct target-triple filenames at build time; keep binary output ignored. Development can use an explicitly resolved Node path. The unsigned bundle smoke must work without Homebrew/system Node on PATH. Verify packaged SQLite, subprocess resolution, resources, runtime logs and actual helper permissions. Signing/distribution remain outside scope.
- [ ] Run deterministic checks: `npm test`, `npm run typecheck`, frontend production build, `cargo test --manifest-path src-tauri/Cargo.toml`, and `git diff --check`.
- [ ] Load current Orca guides; record baseline bound Run and owned resources. Discover provider/account roots, install reversible hook changes, complete supported trust review and start capture. Create a dedicated test Run, launch two read-only same-workspace workers with self-contained tasks and observable acceptance, and observe both before waiting. Keep all created IDs/receipts in private `.capture/` evidence. Never mutate unrelated Runs.
- [ ] Correlate actual hook session IDs against dispatch launch receipts and verified terminal/process bindings. If a directory is the only link, mark failure rather than claiming success. Test native subagent ancestry through an explicitly requested read-only provider child where supported. Use a second test Run only to prove cross-Run isolation. Handle coordinator asks/settlement through the correct test Run; the passive collector never consumes mail. Wait at most 60 seconds per call with progress updates.
- [ ] Accept worker settlements and release each owned terminal using Orca's contract. Preserve unverifiable resources and exact recovery status; never force-close on absence. Restore only test hook additions and verify unrelated config remains. Restore prior coordinator Run binding if one existed. Record remaining resources and config restoration.
- [ ] Record all ten scenario verdicts with live/simulated mode, source evidence and actual versions. Remote restart or unavailable focused-session detection stays unverified. Generate standalone `.capture/report.html`, inspect native Tauri window through Computer Use, and verify grouping, escaping, metrics, close/reopen behavior, Quit and packaged launch. Native observation is required for native claims.
- [ ] Accept only with passing deterministic tests, live same-workspace grouping, one real hook/session join, and verified foreground/idle signals. A failed core join requires architecture revision before a production dashboard. Update `docs/capture-validation.md` with proof limits, without transcripts/private IDs.
- [ ] Commit only Task 5 source/tests/docs and lockfiles as `feat: validate capture in a Tauri dashboard`; inspect committed paths and clean status.

## Final review and stop condition

Check all ten spec scenarios and five Review Focus cases. Keep observed turn completion, accepted task settlement, process exit and unknown contact state distinct. Independent review checks grouping, hook rollback, sidecar lifecycle and packaging. After final edits run the full relevant checks once; broaden only for new failures. Completion means a validated capture harness and a minimal local Tauri report, not a production timesheet UI, persistent service or signed distribution.

## Execution recommendation

Implement inline with `superpowers:executing-plans`, then independent review. A single implementer owns event contracts, account configuration and live-test cleanup. Orca workers are test subjects, not implementation delegates. Subagent-driven implementation is an alternative only if selected by the user.
