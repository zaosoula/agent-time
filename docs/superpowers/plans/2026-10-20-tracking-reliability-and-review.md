# Agent Time tracking reliability and review plan

> Execution note: this plan tracks the full roadmap approved on 2026-10-20. Preserve raw observations, local storage, separate human/agent/elapsed measures, and optional Orca. Use focused tests and a fresh signed Apple Silicon release candidate before public OTA publication.

## Goal

Make first run, daily tracking, diagnosis, review, and recovery understandable and dependable for individual developers while reducing the disk space used by tracking. A successful implementation lets a tester identify why a source has no data, repair it in the app, review uncertain time, and export accurate summaries without implying that inferred or edited time was observed. It also shows what occupies local storage and reduces avoidable growth without silently deleting evidence or changing calculated time.

## Work packages

### 1. Capture and onboarding

- [x] Model each enabled source as paused, off, waiting for first event, receiving, stale, permission limited, hook repair needed, or failed. Include last observation and one next action. Use this model in dashboard, tray, widget, and capture health.
- [x] Verify setup with an actual hook event. Show configuration installed, Codex trust unverified, and first event received as distinct stages. Keep Codex trust unverified until an event arrives.
- [x] Recover a crashed collector with bounded backoff, fail pending requests clearly, and expose recovery state. Ensure intentional shutdown/update does not restart it. Test crash and permanent failure.
- [x] Repair only affected hook targets, explain why repair is needed, and preserve byte-identical configurations and trust.
- [x] Provide a previewable, privacy-safe diagnostic export and retain raw data locally.

### 2. Daily workflow

- [x] Add a daily review inbox for unassigned Mac intervals and uncertain website/project matches. Support bulk assignment and optional future rules.
- [x] Explain uncovered gaps and support separate manual notes/corrections labelled as user-entered, never as observed agent events.
- [x] Add quick pause/resume, timed pause, and app/site exclusions with clear privacy wording.
- [x] Add weekly project review and reviewed-entry export. Keep summed agent time separate from union elapsed time and human time.

### 3. Platform and performance

- [x] Make widget warning actionable with a deep link to capture health/repair and show snapshot age within WidgetKit refresh limits. Packaged URL registration is verified; an actual widget click remains a release acceptance test.
- [x] Check OTA updates when the app is hidden, then surface a native notification or dashboard state. Preserve install-on-click behavior.
- [ ] Benchmark full-history replay on a large local database; introduce versioned daily summaries or equivalent bounded reads. Provide tested archive/export before any retention option; never delete observations automatically. Benchmark and archive are complete. Indexed setting-boundary reads removed a full replay from startup. Safe bounded *daily* summaries still require a reducer checkpoint that preserves long cross-day observed spans.
- [ ] Reduce disk usage: measure the database, indexes, WAL, hook spool, generated runtimes, and archives separately; report their sizes in Settings. Benchmark event volume and bytes per tracked day before setting a target. Remove only provably redundant records in a new verified copy, compare summaries and review decisions before and after, and offer a reversible user-controlled replacement. Archive cleanup must be explicit. Keep the existing live store untouched until the copy passes integrity and restore checks.
- [x] Keep each agent/browser source in its own module. Document capability adapter boundaries and verify one-file additions for matching source formats. The existing source framework and tests meet this boundary.

### 4. Release proof

- [x] Run focused tests, typecheck, full test suite, and Apple Silicon build. Local checks: 198 JavaScript tests, 12 locked Rust tests, Vite build, and a locally signed Apple Silicon app bundle. This bundle is not notarized for distribution.
- [ ] Verify clean-Mac first install and actual signed OTA upgrade/recovery on a separate machine. These are external acceptance tests and must be recorded as observed, not inferred from local tests.
- [ ] Prepare a release record and publish only a verified signed/notarized candidate to the public update feed.

## Baseline and boundaries

- Baseline commit: `6e8e9c2`; work branch: `feat/tracking-reliability-roadmap` in an isolated managed worktree.
- The original main checkout has unrelated uncommitted files; leave them alone.
- Initial `npm test`: 176/178 passed; two macOS helper tests failed under concurrent load because a helper pid file/event did not appear. Re-run focused and full suites after sidecar setup.
- Initial Rust build could not start because `src-tauri/binaries/node-aarch64-apple-darwin` was absent in the new worktree. Run `npm run sidecars:build` first.

## Large-history evidence

On a read-only snapshot of a 429 MB local store with about 553,000 events, loading and parsing the whole history took about 1.1–1.3 seconds and replaying it took about 1.8 seconds with roughly 870 MB of Node heap used. An indexed query for 179 capture setting records took about 1 ms; startup now uses that query instead of loading all events. A three-day replay matched the full daily intervals and totals for the sampled October 17 and 20 days, but it is **not** used in the app because a legitimately observed turn or child span may cross that window. The full summary replay remains a scaling limitation; no historical rows are deleted or silently truncated.

## Implementation update

The follow-on branch adds an on-demand source check, actionable recovery notices, a redacted diagnostic summary with version information, a storage breakdown and growth view, verified archive import, explicit archive deletion, WAL space reclamation, daily trends, reviewed-time project goals, attribution evidence and conflict wording, a troubleshooting guide, and source adapter documentation. The offline copy compactor checks causal event order, full summaries, review decisions, notes, and SQLite integrity after its final vacuum. `npm test` now runs files sequentially because parallel Mac helper and hook self-tests timed out under load; the sequential full suite passed 207 tests.

The full reducer still replays historical events. A bounded daily checkpoint must preserve open turns, tools, child spans, and late events across day boundaries before it can replace that replay. The app therefore does not offer live database replacement or event retention yet. The compactor only writes a separate verified copy. A signed/notarized candidate, clean-Mac first install, actual widget click, and OTA recovery need release-machine proof before publication.

## Candidate improvements after this branch

These are options for the next roadmap review, not claims of shipped behavior.

### Reliability and setup

- Run an end-to-end source check from the app: test the Mac helper, each enabled browser, and each agent hook; show the last successful event and the exact failed step.
- Guide a new user through one real captured session, including Codex hook trust and optional Accessibility, and confirm success in the dashboard.
- Detect sleep, wake, clock changes, low disk space, database corruption, and stale hook runtimes with specific recovery actions.
- Exercise collector restart, timed pause, hook repair, widget navigation, and OTA recovery on clean Macs across supported macOS versions.

### Tracking and review

- Show why an interval belongs to a project, including the evidence, uncertainty, and a one-click correction that preserves the original observation.
- Offer a review queue for conflicting app, browser, and agent attribution; support undo and explain how a saved rule affects future observations.
- Compare daily and weekly trends using separate Mac, summed agent, and elapsed measures; show coverage gaps beside totals.
- Add project-level goals and optional reminders based on reviewed time, with no inferred activity presented as observed work.

### Storage and performance

- Build exact reducer checkpoints for bounded daily reads, including open cross-day turns and child spans, then benchmark large archives against full replay.
- Show a storage breakdown and growth trend; test deduplication and compaction on a copy before offering in-app space recovery.
- Add archive restore/import with integrity checks and a preview of what will be added or replaced.
- Let users choose an explicit retention policy only after a verified archive and restore path exist; never silently prune capture evidence.

### Product and platform

- Add keyboard and VoiceOver paths for the timeline, review controls, health warnings, and setup dialogs.
- Improve widget freshness and warning wording within macOS refresh limits; add a compact menu-bar explanation of today's totals.
- Offer an opt-in, redacted support bundle that includes diagnostics and version information without captured content, paths, or URLs.
- Publish a troubleshooting guide for no events, hook trust, Accessibility, missing Orca, updater failure, and storage pressure.
- Document the source adapter contract and add a fixture-based check for new agent or browser modules.
