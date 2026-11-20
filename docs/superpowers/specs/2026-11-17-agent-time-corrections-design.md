# Agent time corrections

Date: 2026-11-17
Base: upstream `zaosoula/agent-time` `main` at `b5aa2c5` (0.2.0-beta.59), branch `feat/agent-time-corrections`
Status: approach A chosen; design awaiting approval

## Intent

Agent Time sometimes credits agent time that the user does not consider work. The trigger case: the
`rex` agent in `compagny-manager` (Claude session `c91abdaa-6a8b-4b55-a95c-b454c4ef7296`) waits for
scheduled checks with a background Bash shell (`scripts/rex/rex.sh wait`). Background shells are counted
as running without the agent idle cap (`src/capture/correlate.ts`, `addBackground`), so the night of
2026-11-16 → 2026-11-17 was credited as ~7h40 of agent time, and the session's execution shows a
recorded activity interval of `0:00:00–7:59:49`. That breaks the user's view of their day.

The user wants to correct this by hand, from the **Agent execution** details of a session (the
"N recorded activity intervals" list in `src/ui/ActivityDetailsPanel.vue`): for each recorded activity
interval, **delete it** or **change its start or end**. Corrected time must disappear from every total.
Raw evidence must never be deleted.

## Goals

- Delete one recorded activity interval of an agent execution (main agent or subagent) on the selected day.
- Change the start and/or end of one recorded activity interval (shrink only).
- Corrections apply everywhere agent time is reported: day totals, Today page, timeline, session explorer,
  project pages, weekly review, CSV export, billing reports, MCP tools, menu bar, widget snapshot.
- Each correction can be undone. Undoing restores the originally measured time exactly.
- Corrections survive recomputation, restarts and new events arriving later.

## Non-goals

- Extending an interval or adding agent time that was not measured.
- Rules that automatically ignore an agent, project or background shell in the future.
- Changing how capture measures time (background-shell rule stays as is).
- Correcting human (Mac activity) time — it has its own review flow.
- Deleting or rewriting rows in `events`.

## Anti-goals

- Any change that deletes or mutates raw events, or that cannot be fully reverted.
- A correction that silently stops applying after new events arrive or caches rebuild.
- Totals that disagree between screens (session vs day vs billing vs MCP).
- A correction made on one day that changes another day's totals.
- A large data migration. Existing data is untouched; the new table starts empty.

## Approaches

- **A. Time-range exclusions keyed by agent execution identity (chosen).** A new table stores ranges of
  time to remove for one agent execution. After intervals are computed, those ranges are cut out of that
  execution's intervals only. Delete = exclude the interval's range on that day; changing start from S to
  S' = exclude [S, S'); changing end from E to E' = exclude [E', E). Independent of which events bound an
  interval, so it survives intervals merging/splitting, and supports partial trims.
- B. Decisions keyed by an interval's start/end event IDs (like `human_decisions`). Agent intervals are
  re-derived and re-grouped, so the key can stop matching; partial trims need an extra split table.
  Rejected as fragile.
- C. Ignore specific raw events (tombstones). Can only remove whole intervals, cannot trim. Rejected.

The user chose A after confirming the table only holds corrections (no migration of existing data).

## Decisions made with the user

- **Day scope.** A correction only affects the selected local day. An interval crossing midnight is shown
  clipped to the day (as today), and Delete/Edit removes only that day's part. The user corrects the other
  day separately. Ranges are clamped to the local day bounds on write.
- **Task counters.** When `countTaskCounters` is on, exclusions also remove time credited by task counters
  in the excluded range: the user's correction wins, so totals match what they edited.

## Design

### Storage

New table in `events.sqlite`, created with `CREATE TABLE IF NOT EXISTS` in the store setup
(`src/capture/store.ts`), the same way `human_decisions` is created:

```
agent_time_exclusions(
  id TEXT PRIMARY KEY,
  execution_key TEXT NOT NULL,  -- full agentSessionKey of the execution (covers host/provider/session/
                                -- agent/child and Orca dispatchId), exactly as the UI identifies it
  host_id TEXT, provider TEXT, session_id TEXT, agent_id TEXT, dispatch_id TEXT,  -- descriptive copies
  date TEXT NOT NULL,           -- local day YYYY-MM-DD the correction was made on
  start REAL NOT NULL,          -- epoch seconds, inclusive, within the day
  end REAL NOT NULL,            -- epoch seconds, exclusive, end > start, within the day
  created_at REAL NOT NULL,
  undone_at REAL                -- NULL = active
)
```

Index on `(execution_key, start)` and `(date)`. Undo sets `undone_at`; rows are never deleted or edited
otherwise. Matching uses `agentSessionKey` from `src/capture/session-identity.ts` (builder's call,
agreed: store the full key so Orca-dispatched executions are matched exactly). A main-agent exclusion
never affects that session's subagents and vice versa.

### Applying corrections

Exclusions are applied to agent intervals **before totals are computed and after task-counter credit**
for any counter time, so every total derived from intervals reflects them: session `seconds`,
`agentSeconds`, `mainAgentSeconds`, `childAgentSeconds`, `agentWallSeconds`, `elapsedSeconds`, project and
billing totals. Only agent states are cut (running, turn, grouped, waiting, background, and counter-credited
agent time); human intervals are never touched. Fully covered → dropped; partially covered → clipped or
split in two.

Every path that builds a `Summary` must apply them. In beta.59 these are:

- `Collector.windowSummary` (`src/capture/collector.ts` ~678) and the day summary that applies
  `creditTaskCounters` (~704);
- the whole-history `Collector.summary()` (~742);
- the CLI report (`src/capture/cli.ts:32`);
- `snapshot()` in `src/mcp/data.ts` (~119–175), which reads `human_decisions` directly and feeds both the
  MCP tools and billing (`billing-service.ts` `dayInput`).

Session-level `seconds` must be recomputed from the corrected intervals, not kept from raw correlation.

### Cache invalidation

Mirror every place `human_decisions` / `human_splits` participate today:

- `src/capture/dependency-revisions.ts`: add INSERT/UPDATE/DELETE triggers on `agent_time_exclusions` that
  bump `at_dependency_revision.review`;
- `src/capture/ingestion-journal.ts`: add the table to the journaled tables (triggers and change rows)
  so incremental projections and `derived-periods.sqlite` refresh;
- `src/capture/billing-service.ts` (~202): include `agent_time_exclusions` in the billing revision hash;
- `src/capture/storage-migration.ts` (~56) and archive import/export/compaction in `src/capture/store.ts`
  (and `compact-verification.ts` if it enumerates tables): carry the new table.

### Collector API

Two requests through the transport used by human review actions:

- `excludeAgentTime({executionKey, date, start, end})` → returns the updated day summary.
- `undoAgentTimeExclusion({id})` → returns the updated day summary.
- Active exclusions for a day are included with the day summary (or a sibling request) so the UI can list
  them.

Validation: `end > start`; clamp to the local day of `date`; reject ranges that intersect no agent time
of that execution on that day.

### UI (Agent execution details)

In `ActivityDetailsPanel.vue` (agent target), each row of the "recorded activity intervals" list
(`activityDetailSpans`) gets:

- **Edit** — two time inputs (start, end) prefilled, constrained inside the original span. Saving creates
  exclusions for the removed head and/or tail (one or two rows).
- **Delete** — removes the whole span (one exclusion). No browser `confirm()`; use an inline confirm or
  rely on undo.

Corrected executions show "Corrected · −Xh Ym" and a **Corrections** list with **Undo** per row. After a
change, the panel, session header and day totals refresh from the returned summary (same pattern as
`applyReviewedSummary` in `src/ui/store.ts`).

```
Agent execution                                   Close details
2026-11-17 · Measured execution. Corrected −7h 50m.
  Measured time   20m · tool time 8h 7m
▼ 3 recorded activity intervals
  0:00:00–7:59:49   [Edit] [Delete]
  8:55:53–8:59:08   [Edit] [Delete]
  9:04:35–9:10:06   [Edit] [Delete]
Corrections
  Removed 0:00:00–7:59:49              [Undo]
```

### MCP

MCP tools read `snapshot()`, so they get corrected totals once that path applies exclusions. No new MCP
tool for creating corrections.

## Constraints

- Node/SQLite collector, Vue 3 + Reka UI, Tauri host. Follow existing style in `src/capture` and `src/ui`.
- Raw `events` are never modified. The new table is the only write.
- Works with the collector running and another process writing (WAL, `busy_timeout`).
- Run under the project's `.nvmrc` Node version.
- Tests next to existing ones in `tests/`: delete, head trim, tail trim, middle split, main vs subagent
  isolation, dispatched execution matching, day clamping (midnight-crossing interval), task-counter credit
  removed, undo, persistence after a new event arrives, every Summary path (collector day, whole history,
  MCP snapshot, CLI), billing hash change, cache refresh.

## Left to the builder

- Exact seam for applying exclusions (option to `summarize`, or a post-pass recomputing totals with
  existing helpers), as long as every Summary path above is covered and totals agree.
- Where the active exclusions list is delivered to the UI.
- Time input control and inline-confirm style, matching existing components.
