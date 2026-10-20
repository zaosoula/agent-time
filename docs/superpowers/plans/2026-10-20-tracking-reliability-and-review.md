# Agent Time tracking reliability and review plan

> Execution note: this plan tracks the full roadmap approved on 2026-10-20. Preserve raw observations, local storage, separate human/agent/elapsed measures, and optional Orca. Use focused tests and a fresh signed Apple Silicon release candidate before public OTA publication.

## Goal

Make first run, daily tracking, diagnosis, review, and recovery understandable and dependable for individual developers. A successful implementation lets a tester identify why a source has no data, repair it in the app, review uncertain time, and export accurate summaries without implying that inferred or edited time was observed.

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
