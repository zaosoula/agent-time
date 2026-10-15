# Agent Time code consolidation audit — 2026-10-14

Scope: capture/storage, summary transport, day-view computation, timeline rendering, usage import, native bridge, and the existing tests. Measurements below used a read-only connection to the live database (about 116,000 events); the index experiment used a disposable SQLite backup. The live recordings and decisions were not pruned.

## Changes made

| Area | Before | After |
| --- | --- | --- |
| Day-view session matching | Re-scanned every interval for every session: 745 sessions and about 12,100 day intervals took 219 ms in a standalone comparison | Shared interval index took 2 ms; all 745 session matches and project-filter matches agreed with the previous rules |
| Project human bars | About 3,435 individually drawn sample spans across five projects | 228 visual bars after joining only touching/overlapping spans; stored events and time calculations remain unchanged |
| Dashboard summary response | 13.5 MiB of full-history JSON for one selected day | 6.4 MiB day-scoped JSON; the collector and report retain the full summary |
| Capture-health recent query | Full event-table scan; 6.34 ms per read on a disposable copy | Indexed source lookup; 0.01 ms per read on that copy, with an approximately 1.5 MiB index |

The interval index preserves session, Dispatch, and subagent identities. Visual coalescing preserves gaps and keeps Mac/browser aggregate tooltips separated by source. Date changes request the newly selected day; the Rust and Node request validators still reject unrelated parameters.

## Remaining performance and maintainability work

1. **Full-history replay grows with retention.** At this database size, a standalone full summary read took about 120 ms for SQLite, 145 ms for JSON parsing, and 403 ms for correlation, with about 410 MiB process RSS. The collector caches the result, but a cache miss still replays all history. The next structural change should persist a versioned daily projection or checkpoint while keeping raw evidence available for reprocessing. It needs migration, restart, and late-event tests before changing live data.
2. **The day response still carries global issue and session arrays.** Intervals dominate its size, but coverage and unresolved issues together add about 1.2 MiB. Timestamped issues and a bounded day query could reduce transport further without hiding historical diagnostics.
3. **The database needs a retention policy, not an automatic deletion rule.** The current SQLite file is about 96 MiB, led by the `events` table at about 74 MiB. Orca, macOS, and hook payloads account for about 31.7, 15.9, and 14.0 MiB respectively. An archive or compacted evidence format should be specified and verified separately before any live pruning.
4. **Usage aggregation repeats history queries.** The token summary rebuilds captured-session membership from hook events and reparses current-period usage rows on demand. A revision-aware aggregate cache is a sensible next optimization once its refresh and pricing invalidation rules are explicit.
5. **`App.vue` remains tightly packed.** The day-view indexing and visual coalescing now live in small pure modules. Further splitting should follow stable ownership boundaries (day view, review, navigation) with UI regression checks; reformatting or extracting the whole component at once would make behavioral review harder.

## Verification boundary

140 Node tests and 5 Rust tests pass. The signed desktop app was rebuilt and relaunched; today and previous-day timelines loaded, capture remained running, and SQLite `PRAGMA quick_check` returned `ok`. `npm audit --omit=dev` reported zero dependency advisories at this check. These checks do not prove future long-running memory behavior or the proposed archive/checkpoint migration.
