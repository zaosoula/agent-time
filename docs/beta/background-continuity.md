# Background work across resumed conversations

A conversation ID identifies history, not an uninterrupted execution. These two guards prevent inferred background duration from absorbing an unobserved overnight gap. They do not exclude sleep globally or change foreground idle settings.

## Explicit restart or resume

On a native SessionStart whose source is startup or resume, preserve the old background task's confirmed segments and stop carrying its open lifetime into the new invocation. Clear stale Orca Dispatch bindings for that native host/provider/session; keep original tool bindings so genuinely late tool ends remain attached to the execution that opened them. In-place context compaction does not reset background work.

## New work without a restart event

An ordinary prompt following a session silence longer than the configured agent idle threshold (five minutes by default) opens a new observation segment. A later list saying the old task is still running can confirm the new segment, but cannot fill the silent gap. A task absent from that list cannot manufacture a new segment, including across a permission wait. A late SessionEnd preserves the last confirmed segments instead of extending them to shutdown.

The original launch remains available. An explicit matching task-completion notification can confirm the complete background run, including a genuinely long task; speculative segment splits do not truncate it. Work with continuous observations also retains its duration. Unconfirmed continuity is marked unknown; missing observations do not prove that a process physically stopped.

## Archive verification, 13 November 2026

Read-only replay of the supplied client archive reproduces the screenshot: 625 cumulative agent minutes, 69 human minutes and a 9.06 ratio. The previous restart guard alone still returns 625 minutes because that conversation emitted no SessionStart on reuse. Both guards return 57 agent minutes and the same 69 human minutes: exactly 568 minutes (9h28) removed.

Across the full replay window, 8,222 non-background intervals (tools, turns, waits and human observations) remain identical, as do 27 explicitly completed background runs with their full original durations. Replaying without background metadata returns the same 103 foreground agent minutes before and after. The final archive, later than the screenshot, changes from 1,544 to 187 cumulative agent minutes because delayed session closures had added other old background spans as well. Human time stays 108 minutes.

These are evidence-based computation checks, not proof of every process's activity during an unobserved gap. The archive, event history, manual decisions and existing saved billing report snapshots are untouched. Derived review caches are invalidated; future billing calculations use the new calculation revision. Neither guard is included in beta.52; publishing a later version is a separate step.

Validation: 642 JavaScript tests passed, production typecheck/build passed, and independent code review verified repeated gaps, long explicit completions and permission-wait preservation. Archive replay uses a read-only decompressed copy; raw customer data is not committed.
