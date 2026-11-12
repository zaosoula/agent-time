# Startup and billing performance

Request: audit slow startup, billing navigation and calculation; improve speed and show useful progress without changing time or billing semantics.

Evidence: live read-only probe of 1.44 million events lists billing projects in 7 ms; a single billing-evidence snapshot did not finish within 66 seconds. SQLite chooses a provider-only hook index for each older session-metadata query, scanning/sorting the provider's history repeatedly. Billing attribution does not consume launcher identity/attribute anchors, but older work context remains necessary for prompt-presence qualification. Settings currently mounts every hidden panel (`unmount-on-hide=false`), including storage measurement, integration checks and billing. Its website poll also scans known workspaces on every settings section.

- [x] Lazily mount settings panels once visited, retaining unsaved edits; restrict website polling to Projects & rules.
- [x] Prioritize the first selected-day summary over background review work; keep existing current-day and review semantics.
- [x] Skip launcher-only metadata hydration for billing evidence, batch older work context in one scan, and retain capture boundaries, manual decisions, host matching, equal-timestamp context order and causal window evidence. Differential-test attributed intervals/totals and benchmark read-only real history.
- [x] Add worker-to-collector report progress and bounded read-only polling, plus elapsed time and honest stage/day progress in the billing UI. Preserve old API callers and saved report/export behavior.
- [x] Run focused/full affected gates, test pending/error/navigation states, and record actual measurements and remaining limits.

No live history/settings changes, synthetic percentages, billing-rule changes, global caches or database migration are needed. Existing causal lookback remains intact. A report may still take time on busy histories; preserve capture responsiveness and provide feedback throughout.

## Audit findings and evidence

- Billing project listing itself took 7 ms initially (23 ms during the final busy run). Slow navigation came from mounting all hidden settings panels and polling known website workspaces even in Billing. Panels now mount on first visit and retain their edits. Website discovery polls only in Projects & rules.
- Startup requested the seven-day review backlog before its primary day was displayed, and summary delivery waited for optional task declarations. Home now asks only for current review status after the primary summary; Review still gets its backlog. Optional declarations have a single in-flight request and stale-day guards, without delaying measured activity.
- Report preparation performed per-native-session historical metadata queries. SQLite selected a provider-only index; the report-context index also repeatedly decompressed the same history blocks. One observed context lookup cost417 ms; hundreds repeated. A read-only single-day billing snapshot over approximately1.44 million events exceeded66 seconds and was interrupted. The final path took2336 ms during a run also executing the test/build gates. The causal reducer itself took211 ms; window reading took201 ms in an isolated phase probe.
- Final consistent-snapshot benchmark, November1–11:25839 ms for11 days,23 worker progress messages, peak process RSS493760 KiB. These are diagnostic timings under local load, not latency guarantees. Report totals are not published in this audit. The live capture database/settings were never modified by benchmarks; report writes and protocol startup used a disposable SQLite backup.
- A cold protocol benchmark on that backup returned status/summary/project-list replies at approximately5.0–5.1 seconds, without starting capture. This is not an end-to-end native app launch benchmark. Reading/decompressing daily windows and legacy usage-pricing binding remain visible costs. No persistent summary cache was introduced: causal evidence, review changes and historical attribution need exact invalidation proof first.
- Progress shows actual completed dates, the current date, a saving stage and elapsed time. It uses indeterminate feedback while connecting/loading/finalizing. It does not invent a percentage or estimated finish time. Concurrent collector report workers are restricted to one, and progress retains at most8 small entries with10-minute completed/failed expiry; reports/events are not cached in the progress registry.

## Preservation and verification

Review found two subtle context invariants before completion: old context qualifies projectless prompts for presence policies, and equal-timestamp contexts must keep original native/host insertion order. Both are preserved and regression tested, including explicit empty-host matching. Packed-history attributed intervals and summaries match the reference path; financial counting/rounding logic is unchanged.

Browser checks with synthetic data: billing-list loading indicator; real progress advancing0→4 of6; switching General/Billing during work; successful result; failed report re-enables Generate and keeps prior result; unsaved project-name edit survives tab switches; startup indeterminate feedback. No unvisited storage measurement or website-discovery request was issued. Screenshot evidence is a local preview, not a released app build.

Native bridge gate:33 tests passed. Production UI build and typecheck passed. The focused billing/editor/protocol review passed22 tests with no remaining blockers. Full suite:585 tests passed (185.2 seconds). Added declaration files for the public documentation modules to repair the prior website tests' missing-type build error.
