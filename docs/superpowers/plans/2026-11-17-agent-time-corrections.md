# Agent Time Corrections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user delete or shrink a recorded agent activity interval of one execution on one day, from the Agent execution details panel, with undo, and have every total reflect it.

**Architecture:** A new `agent_time_exclusions` table stores absolute time ranges to remove for one execution key (`agentSessionKey`). A pure function `applyAgentExclusions` cuts those ranges out of agent intervals and adjusts totals by delta (same technique as `creditTaskCounters`). It runs as the **last** step of every Summary path, after task-counter credit. Triggers on the table bump the review revision and journal a range change so every cache and the billing ingestion model refresh.

**Tech Stack:** TypeScript on Node (`node:sqlite`, `node:test`), Vue 3 SFCs, Tauri 2 (Rust method allowlist).

**Spec:** `docs/superpowers/specs/2026-11-17-agent-time-corrections-design.md`

## Global Constraints

- Base: upstream `main` `b5aa2c5` (0.2.0-beta.59), branch `feat/agent-time-corrections`.
- Run every command under the project Node: `source ~/.nvm/nvm.sh && nvm use` (add `.nvmrc` matching `engines` in `package.json` if missing — first task does this).
- Tests: `node --test --test-concurrency=1 tests/<file>.test.ts`; full suite `npm test`; types `npm run typecheck`; Rust `cargo test --manifest-path src-tauri/Cargo.toml`.
- Raw `events` rows are never inserted, updated or deleted by this feature.
- Only agent states are cut: `running`, `turn`, `grouped`, `waiting`. `human` intervals are never modified.
- A correction is clamped to the local day of its `date` (`localDayBounds(date)`), never affects another day.
- Exclusions apply after `creditTaskCounters` wherever counters are credited.
- Code style: match surrounding file (compact TS in `src/capture`, existing Vue style in `src/ui`). No browser `confirm()`/`alert()`.

## Review Focus

1. Interval crossing midnight: deleting on Nov 17 must leave Nov 16 totals byte-identical. → Task 3 test `midnight-crossing correction leaves previous day unchanged`.
2. New hook events arrive after a correction (shell keeps running): excluded range stays removed, time after `end` counts. → Task 3 test `correction persists after new events extend the interval`.
3. Two overlapping corrections, undo one: the other still applies, no double-subtraction of totals. → Task 1 test `overlapping exclusions subtract once` and Task 2 test `undo keeps other exclusions`.
4. A second process (not owning `capture.lock`) tries to correct: rejected with the same error as human review. → Task 4 test.
5. Correction on a main agent must not change its subagents (and dispatch-keyed executions match exactly). → Task 1 tests.

---

### Task 1: Pure exclusion engine

**Files:**
- Create: `src/capture/agent-exclusions.ts`
- Test: `tests/agent-exclusions.test.ts`
- Create if missing: `.nvmrc` (value from `engines.node` in `package.json`)

**Interfaces:**
- Produces:
  - `export interface AgentTimeExclusion {id:string;executionKey:string;date:string;start:number;end:number;createdAt:number;undoneAt?:number}`
  - `export function subtractRanges(ranges:Array<[number,number]>,cuts:Array<[number,number]>):Array<[number,number]>`
  - `export function applyAgentExclusions(summary:Summary,exclusions:readonly AgentTimeExclusion[]):Summary` — ignores rows with `undoneAt`; returns the **same object** when nothing intersects.

- [ ] **Step 1: Write failing tests** in `tests/agent-exclusions.test.ts` (build Summaries by hand; keys via `agentSessionKey` from `src/capture/session-identity.ts`):
  - `deleting a whole interval removes it and its credit`: one main `grouped` interval [0,3600] + session `seconds:3600`, `agentSeconds:3600`, `mainAgentSeconds:3600`, `agentWallSeconds:3600`, `elapsedSeconds:3600`; exclusion [0,3600] → no agent intervals left; all five totals and `session.seconds` equal 0.
  - `head trim`, `tail trim`, `middle split`: exclusion [0,1800] → interval [1800,3600]; [1800,3600] → [0,1800]; [1200,2400] → two intervals [0,1200],[2400,3600]; totals drop by `minuteCreditSeconds` delta (1800 / 1800 / 1200).
  - `main agent exclusion does not touch subagents`: main + child (`child:true, agentId:'a1'`) both [0,3600]; exclusion with main key → child interval and `childAgentSeconds` unchanged.
  - `dispatch execution matched by dispatch key`: interval with `dispatchId:'d1'`; exclusion keyed `agentSessionKey({hostId,dispatchId:'d1'})` applies; one keyed by its `sessionId` does not.
  - `human intervals are never cut`: human [0,3600] same time range → unchanged, `humanSeconds` unchanged.
  - `counter-credited interval is cut`: `running` interval with `sourceEventIds:['counter-id']` inside range → removed.
  - `overlapping exclusions subtract once`: [0,2000] and [1000,3000] on [0,3600] → remaining [3000,3600], totals reduced by exactly 3000 credit.
  - `undone exclusions are ignored` and `no intersecting exclusion returns the same summary object` (`assert.equal(result, summary)`).

- [ ] **Step 2: Run** `node --test tests/agent-exclusions.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement** in `src/capture/agent-exclusions.ts`. Match intervals with `agentSessionKey(interval)===exclusion.executionKey` and `interval.state!=='human'`. Clip/split each matching interval; copy all other fields. Totals by delta, per key, using `minuteCreditSeconds` from `correlate.ts` over that key's agent ranges before vs after: subtract from matching `session.seconds` (sessions matched by `session.key===executionKey`), from `agentSeconds` (and `mainAgentSeconds` when present) for non-child keys, from `childAgentSeconds` for child keys. `agentWallSeconds` (if present) and `elapsedSeconds` = old minus (credit of union of all agent ranges [+ human ranges for elapsed] before − after). Never let a total go below 0.

- [ ] **Step 4: Run** `node --test tests/agent-exclusions.test.ts` → PASS.

- [ ] **Step 5: Commit** `feat: add agent time exclusion engine`

### Task 2: Storage, revisions and journal

**Files:**
- Modify: `src/capture/store.ts` (table creation near line 44; methods near `humanDecisions()` ~227; archive merge ~461–465)
- Modify: `src/capture/dependency-revisions.ts:20` (trigger table list)
- Modify: `src/capture/ingestion-journal.ts` (kind union line 11; triggers ~45; schema_version)
- Modify: `src/capture/ingestion-model.ts` (~77, change handling)
- Modify: `src/capture/billing-service.ts:202` (revision hash)
- Test: `tests/agent-exclusions-store.test.ts`; extend `tests/ingestion-journal.test.ts`, `tests/billing-service.test.ts`

**Interfaces:**
- Consumes: `AgentTimeExclusion` (Task 1).
- Produces on `EventStore`:
  - `addAgentTimeExclusion(input:{executionKey:string;date:string;start:number;end:number;hostId?:string;provider?:string;sessionId?:string;agentId?:string;dispatchId?:string}):AgentTimeExclusion`
  - `agentTimeExclusions(date?:string):AgentTimeExclusion[]` — active only (`undone_at IS NULL`), ordered by `start`.
  - `undoAgentTimeExclusion(id:string):AgentTimeExclusion` — sets `undone_at`; throws `Error('Correction not found')` if missing or already undone.
- Produces in journal: `IngestionChange.kind` gains `'range'`, with `pairs` holding `[[start,end]]` numbers.

- [ ] **Step 1: Write failing tests:**
  - `exclusions persist across reopen and undo keeps other exclusions`: add two, reopen `EventStore`, both listed; undo first → only second listed; row still in table with `undone_at` set.
  - `adding or undoing bumps the review revision`: `store.dependencyRevision('review')` differs after add and after undo.
  - `range changes are journaled`: after add, `readIngestionChanges` returns a change `{kind:'range',pairs:[[start,end]]}`.
  - `ingestion marks overlapping credited slices dirty on a range change` (in `ingestion-journal.test.ts` or model test, following existing 'review' test pattern).
  - `billing revision changes when an exclusion is added` (follow existing human-decision hash test in `billing-service.test.ts`).
  - `archive merge copies exclusions` when the archive has the table, and tolerates archives without it.
- [ ] **Step 2: Run** those tests → FAIL.
- [ ] **Step 3: Implement.** Table DDL exactly as in the spec (`agent_time_exclusions`, columns `id, execution_key, host_id, provider, session_id, agent_id, dispatch_id, date, start, end, created_at, undone_at`) plus indexes `(execution_key,start)` and `(date)`. Add `'agent_time_exclusions'` to the dependency trigger loop. Ingestion triggers for INSERT/UPDATE on the table write kind `'range'` with `json_array(json_array(NEW.start,NEW.end))`; bump `schema_version` to 3 so upgrade recreates triggers. Model: for `'range'`, `UPDATE credited_slices SET dirty=1 WHERE activity_from<=? AND activity_to>?` with (end,start). Billing hash: also iterate `SELECT * FROM agent_time_exclusions ORDER BY id`. Archive merge: `INSERT OR IGNORE` guarded by table existence, like `human_splits`. Do **not** add the table to `verifyDatabase`'s required list.
- [ ] **Step 4: Run** those tests plus `tests/dependency-revisions.test.ts tests/ingestion*.test.ts tests/billing-service.test.ts tests/archive*.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat: store agent time exclusions with cache revisions`

### Task 3: Apply exclusions in every Summary path

**Files:**
- Modify: `src/capture/collector.ts` (`reviewData` ~684, `daySummary` ~689–707, `summary()` ~742)
- Modify: `src/capture/cli.ts:32`
- Modify: `src/mcp/data.ts` (`snapshot`, ~119 and ~175)
- Test: `tests/agent-exclusions-summary.test.ts`

**Interfaces:**
- Consumes: `applyAgentExclusions` (Task 1); `EventStore.addAgentTimeExclusion`, `agentTimeExclusions` (Task 2).
- Produces: `reviewData()` returns `{revision,decisions,splits,exclusions}`.

- [ ] **Step 1: Write failing tests** (Collector in a temp dir, events via `makeEvent('hook',...)` like `tests/human-review.test.ts`; add exclusions directly with `collector.store.addAgentTimeExclusion`):
  - `day summary removes excluded agent time`: tool_start/tool_end 1h on a fixed day; exclude the hour → `collector.summaryForDate(date).agentSeconds===0` and session `seconds===0`.
  - `midnight-crossing correction leaves previous day unchanged`: background interval 23:00→01:00 (tool_end with `backgroundTaskId` then `prompt_submitted` with same id); `summaryForDate(prev)` captured; exclude 00:00–01:00 on next day → next day agent 0, `JSON.stringify(summaryForDate(prev))` unchanged.
  - `correction persists after new events extend the interval`: exclude, then put later events; excluded range still absent, later time counted.
  - `task-counter credit in an excluded range is removed`: with `countTaskCounters` on and a counter report covering the range → `agentSeconds` 0 for the range.
  - `MCP snapshot and whole-history summary agree with the day summary`: `snapshot(output,from,to)` agent totals and `collector.summary()` intervals reflect the exclusion.
  - `undo restores the original totals exactly`: after `store.undoAgentTimeExclusion`, `summaryForDate` equals the pre-correction summary's totals.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** `reviewData` also loads `store.agentTimeExclusions()`. In `daySummary`, apply `applyAgentExclusions(value, exclusions)` to the final value after `creditTaskCounters`, before memoising and `putView`; include the exclusions in the `derivedMemo` identity check. `summary()` and `cli.ts`: wrap the `applyHumanDecisions(...)` result. `snapshot`: read active rows with one `SELECT` like `decisions`, apply after `creditTaskCounters` (line ~175) before clipping.
- [ ] **Step 4: Run** the new file plus `tests/collector.test.ts tests/mcp.test.ts tests/human-review.test.ts tests/billing-*.test.ts tests/home-*.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat: apply agent time corrections to all summaries`

### Task 4: Collector API, protocol and Tauri allowlist

**Files:**
- Modify: `src/capture/collector.ts` (next to `undoReviewAction` ~547)
- Modify: `src/capture/protocol.ts` (Controller interface line 16; handlers near `manual_notes` ~157)
- Modify: `src-tauri/src/lib.rs` (`validate_method` ~330–345; tests ~556)
- Modify: `src/ui/transport.ts` (new `agentTimeCorrectionTransport` next to `manualNoteTransport` line 115)
- Test: `tests/protocol.test.ts`, `tests/agent-exclusions-summary.test.ts`, Rust test module in `lib.rs`

**Interfaces:**
- Consumes: Task 2 store methods.
- Produces:
  - `Collector.excludeAgentTime(executionKey:string,date:string,start:number,end:number):Summary` — throws `'Review activity in the app that owns capture'` when the lock is not owned (same check as `setHumanDecision`); clamps to `localDayBounds(date)`; throws `'Choose a range inside this day'` if empty after clamp; throws `'Activity changed; refresh and try again'` if the range intersects no agent interval of that key in `windowSummary(date)`; fills descriptive columns from the matching session; returns `daySummary(date)`.
  - `Collector.undoAgentTimeExclusion(id:string,date:string):Summary`
  - `Collector.agentTimeExclusions(date:string):AgentTimeExclusion[]`
  - Protocol methods: `agent_time_exclude {executionKey,date,start,end}`, `agent_time_exclusion_undo {id,date}`, `agent_time_exclusions {date}` — exact key sets, `date` `YYYY-MM-DD`, `executionKey` string ≤ 1024 chars, `start`/`end` finite with `end>start` and `end-start<=86400`, `id` 36-char UUID.
  - `agentTimeCorrectionTransport = {list(date):Promise<AgentTimeExclusion[]>, exclude(executionKey,date,start,end):Promise<Summary>, undo(id,date):Promise<Summary>}`
- [ ] **Step 1: Write failing tests:** protocol accepts valid params and rejects extra keys, bad date, `end<=start`, range > 86400, bad id; Rust `validate_method` mirrors the same accept/reject cases; collector tests for lock rejection, clamp, no-intersection rejection, round trip exclude → list → undo.
- [ ] **Step 2: Run** `node --test tests/protocol.test.ts tests/agent-exclusions-summary.test.ts` and `cargo test --manifest-path src-tauri/Cargo.toml` → FAIL.
- [ ] **Step 3: Implement** following the `manual_notes` / `human_decision_set` handler patterns.
- [ ] **Step 4: Run** same commands → PASS.
- [ ] **Step 5: Commit** `feat: expose agent time corrections through the collector protocol`

### Task 5: Edit, delete and undo in the Agent execution panel

**Files:**
- Modify: `src/ui/activity-detail-target.ts` (pure helper)
- Modify: `src/ui/ActivityDetailsPanel.vue` (agent template ~30–34, script)
- Modify: `src/ui/store.ts` (apply returned summary like `applyReviewedSummary` ~358; load corrections for the selected date)
- Test: `tests/activity-details.test.ts`

**Interfaces:**
- Consumes: `agentTimeCorrectionTransport` (Task 4), `AgentTimeExclusion` (Task 1).
- Produces:
  - `export function trimCuts(span:{start:number;end:number},next:{start:number;end:number}):Array<[number,number]>` — returns the head `[span.start,next.start]` and/or tail `[next.end,span.end]` to exclude; throws `Error('Keep the new times inside the original interval')` if `next` is outside `span` or `next.end<=next.start`.
  - Store: `agentCorrections: Ref<AgentTimeExclusion[]>`, `excludeAgentTime(executionKey,start,end)`, `undoAgentTimeCorrection(id)` using `selectedDate`.

- [ ] **Step 1: Write failing tests:** `trimCuts` head only, tail only, both, unchanged → `[]`, invalid → throws. Panel script test (same transpile harness as the existing focus test): Delete then confirm calls `exclude` with the span's start/end and the execution key; Edit save calls `exclude` once per cut; Undo calls `undo(id)`; no `confirm`/`alert` referenced in the SFC source.
- [ ] **Step 2: Run** `node --test tests/activity-details.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Each interval row: times, **Edit** (two `<input type="time" step="1">` prefilled, bounded to the span; Save/Cancel) and **Delete** (inline "Remove this time? Remove / Keep"). Below the list: "Corrections" with "Removed HH:MM:SS–HH:MM:SS · Undo" for active corrections whose `executionKey===execution.key`; header line shows "Corrected · −{duration}" when any exist. Errors render inline. After success, apply the returned Summary through the store so session header and day totals refresh.
- [ ] **Step 4: Run** `node --test tests/activity-details.test.ts` and `npm run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat: edit and delete agent activity intervals`

### Task 6: Whole-branch verification

- [ ] **Step 1:** `npm test` → all pass. `npm run typecheck` → no errors. `cargo test --manifest-path src-tauri/Cargo.toml` → pass.
- [ ] **Step 2:** Build and run the app (`npm run sidecars:build && npm run tauri dev`) against a **copy** of the data directory (`ADE_CAPTURE_OUTPUT=<scratch copy>`), open Session S01 on 2026-11-17, delete `0:00:00–7:59:49`, check session, day and project totals drop by the same amount, Nov 16 unchanged, Undo restores.
- [ ] **Step 3:** Commit any fixes; final review of the branch.
