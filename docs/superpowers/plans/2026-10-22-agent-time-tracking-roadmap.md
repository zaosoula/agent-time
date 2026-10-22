# Agent Time tracking reliability roadmap

The owner authorized the recommended sequence on 2026-10-22. Work stays local first and Apple Silicon only. Preserve existing tracking data and the original event evidence. Each phase must be independently reviewable before publication.

## 1. beta.6 maintenance update

- [x] Bump all five version declarations together and document the two merged fixes: guarded old hook runtime pruning and semantic Codex hook configuration comparison.
- [x] Run JavaScript, frontend, Rust, packaged collector, signing, notarization, and Gatekeeper checks on the exact candidate.
- [x] Validate a signed beta.5 to beta.6 OTA on the release Mac with retained history and new Claude/Codex events; preserve verified app and database backups before promoting the exact candidate.

## 2. Reliability and OTA proof

- [ ] Exercise offline feed, interrupted download, invalid signature, failed install/restart, and recovery against an isolated test feed. Show whether capture continues or resumes in each case.
- [ ] Run a multi-day capture soak with event continuity, memory, CPU, battery, and storage samples; distinguish the duration actually observed from the target.
- [ ] Verify a clean install at the claimed minimum macOS version before stating that version is supported.

## 3. Incremental daily summaries

- [ ] Replace repeated full-history summary replay with a bounded or checkpointed daily projection that preserves cross-midnight intervals, capture fences, Orca identities, human review decisions, and archival imports.
- [ ] Compare projected and full-history results on representative copied databases, then benchmark latency and memory. Fall back safely if a projection is stale or incompatible.

## 4. Capture confidence and repair

- [ ] Expose day and source confidence using received events, configured hooks, provider trust limits, permissions, pauses, and coverage gaps. Do not label a configured hook as verified without delivery.
- [ ] Connect each actionable state to the narrow repair route; keep informational states distinct from failures. Verify widget and notification behavior with stale snapshots.

## 5. Attribution review

- [ ] Improve the unassigned and conflicting activity review path, preserving captured evidence and reversible user decisions.
- [ ] Add focused filters and evidence details, then verify corrections across timeline, daily totals, weekly review, and export.

Publication is separate from merging code. The public feed must always point to the exact signed candidate that passed release checks.
