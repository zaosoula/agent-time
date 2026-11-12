# Project Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** SQLite-backed billable projects, reproducible financial summaries, MCP and local exports without changing measured history.
**Architecture:** Shared typed model, additive SQLite storage, pure raw-interval billing reducer, bounded report adapter and UI. Keep immutable policies/report results separate from capture events.
**Tech Stack:** TypeScript, node:sqlite, Vue, existing local MCP and Tauri IPC; no new dependencies.
**Spec:** docs/superpowers/specs/2026-11-12-project-billing-design.md

## Global Constraints
- Database is canonical; no configuration-file source of truth.
- Legacy timing, human decisions and user dirty files remain intact.
- No invented presence/cost, no task-counter billing by default, no silent unknown-project zero.
- Long ranges use bounded daily reads; monetary calculations avoid floating-point accumulation.
- Published beta only after tests, review, signed build, public and packaged verification.

## Review Focus
- Rounding/caps across midnight, DST, tariff revisions and separate rates must be deterministic.
- Unknown or ambiguous project sources, missing message evidence and partial cost data stay explicit.
- Concurrent edits and imported archives must not overwrite immutable policies or reports.
- Three repositories with simultaneous agents produce one project clock, not three.
- Compaction/archive/restore preserve billing configuration and report records.

### Task 1: SQLite project/policy/report persistence
Files: src/capture/billing-store.ts; src/capture/store.ts; related archive/copy paths; tests/billing-store.test.ts.
Consumes shared billing-types.ts. Produces BillingStore(db) with listProjects(), saveProject(project,expectedRevision?), resolveProject(alias), saveReport(report), report(id).
- [x] Failing tests for reopen/legacy DB, version conflict, immutable policies, aliases, report snapshots and archive/copy preservation.
- [x] Implement additive validated storage and existing archive lifecycle integration.
- [x] Focused tests and review.

### Task 2: Pure exact billing reducer
Files: src/capture/billing-engine.ts; tests/billing-engine.test.ts.
Consumes BillingProject and iterable BillingDayInput; produces calculateBilling(project, inputs, {fromDate,toDate,reportId?}):BillingReport and renderBillingExport(report,format).
- [x] Failing tests for union across repositories, factors, rates, rounding/caps, DST/date versions, exclusions, presence, unknown costs and no double use of task costs.
- [x] Implement bounded per-day reduction, deterministic currency-aware arithmetic and safe CSV/Markdown rendering.
- [x] Focused tests and review.

### Task 3: Bounded adapter, MCP and app IPC
Files: src/capture/billing-service.ts; src/mcp/data.ts; src/mcp/server.ts; src/capture/collector.ts; src/capture/protocol.ts; src-tauri/src/lib.rs; relevant tests.
- [x] Build day inputs from existing query-only snapshot intervals (raw seconds), captured message metadata, coverage and reported own-task usage; avoid unbounded history accumulation.
- [x] Add billing_projects, billing_for_project, saved-report pagination/export and strict app IPC save/report calls.
- [x] Add summary mode and long ranges/alias errors to time_for_project without breaking details callers.
- [x] Real MCP/IPC regression tests including 31-day month, read-only old archives and limits.

### Task 4: Project billing settings and report UI
Files: src/ui/BillingSettings.vue; src/ui/CaptureSettings.vue; focused UI tests.
- [x] Forms for grouped sources/aliases, all policy fields and effective-date revisions; no raw JSON editing required.
- [x] Period report, separate fees, quality warnings, daily breakdown and local CSV/Markdown exports.
- [x] Typecheck/build and synthetic browser verification.

### Integration and release
- [x] Fresh independent engine/storage/integration reviews; findings fixed; 504-test initial JS suite plus latest focused regressions, build and audit pass. Native CI remains a release gate.
- [x] Document config/API and implementation rulings.
- [x] Published and verified beta46, including 511 JavaScript and 33 native tests.
- [x] Verified beta46 public bytes, packaged API/IPC, signature/notarization and browser workflow.
- [x] Published/verified beta47 compatibility patch; 513 JavaScript and 33 native tests pass. Packaged IPC/MCP, public bytes, signature/notarization and cleanup recorded in docs/beta/release-record.md.
