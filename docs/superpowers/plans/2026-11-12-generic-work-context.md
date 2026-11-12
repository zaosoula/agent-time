# Generic Work Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** Generic measured-session identity and attributes plus linked Git-worktree grouping, without changing timing or native IDs.
**Architecture:** Shared bounded metadata contract; hook/correlation enrichment; backend-only canonical path resolver; temporal MCP read projections over unchanged measured spans.
**Tech Stack:** Existing TypeScript/SQLite/Vue/MCP, no new dependencies.
**Spec:** docs/superpowers/specs/2026-11-12-generic-work-context-design.md

## Global Constraints
- No ERP-specific columns, external messages, webhooks or timesheet writes.
- Business identity, native identity and profile remain distinct.
- Existing unfiltered timing values, native IDs and billing snapshots remain unchanged.
- Explicit env opt-in only; bounded bytes and window-local pooling.
- Ordinary worktrees retain raw cwd and canonical path; no invented deleted/remote filesystem history.

## Review Focus
- Parallel sessions with identical native IDs in different providers/hosts never share context.
- Metadata changes during a grouped interval do not create extra credited minutes.
- Invalid/oversized attributes never discard otherwise valid timing hooks.
- Copied installed hooks include every new helper dependency.
- Nested billing subprojects and missing/remote Git paths preserve existing behavior.

### Task 1 — Shared metadata, hook ingestion and correlation
Own work-context.ts, hooks.ts, correlate.ts, summary-window.ts, hook-installation.ts and focused tests. Root owns shared events.ts interfaces.
- [x] Failing tests for env isolation/bounds, identity/profile separation, timing invariance and copied-runtime execution.
- [x] Export validateAttributes, validateAgentIdentity, applyWorkAttributes, readLauncherContext and eventWorkMetadata.
- [x] Merge only approved metadata after provider normalization; attach canonical projectPath using Task2 resolver.
- [x] Propagate launcher metadata to sessions/intervals and pool repeated maps per bounded parser.
- [x] Verify focused tests and fresh review.

### Task 2 — Generic Git worktrees and pure UI paths
Own project-path.ts, website-resolver.ts resolver re-export, UI project-identity helpers/consumers and reported-resources.ts path handling. Coordinate with Task1 hooks/correlation and Task3 data.
- [x] Failing temporary-Git tests for ordinary worktrees, nested cwd, spaces, removed paths, separate git dirs, local/remote and subproject preservation.
- [x] Export resolveProjectPath(path, {hostId?}?) plus existing projectPathFromWorktree compatibility; bounded cache and no per-interval Git process.
- [x] Pure browser helpers prefer optional projectPath, without importing Node resolver.
- [x] Verify focused tests and fresh review.

### Task 3 — Temporal MCP declarations and reads
Own mcp/server.ts, report.ts, data.ts, capture/reported-work.ts, capture/billing-service.ts and focused MCP tests.
- [x] Failing tests for attribute inheritance/clear/retry, validator/spool byte parity, root profile reads and agent filters.
- [x] Attributes use Task1 validation; 4096-byte report cap shared by writer/reader.
- [x] Resolve metadata per native execution and timestamp; preserve identity provenance/evidence and expose contributors/context slices with truncation flags.
- [x] Extend sessions, timeline and actual time_for_project daily adapter; no agent claims unassociated human time, no re-rounding metadata splits.
- [x] Hydrate bounded older session context evidence where required; retain measured totals/cross-midnight behavior.
- [x] Verify real stdio MCP and fresh review.

### Integration and release
- [x] Full suite/typecheck/build/audit, independent whole-change review, installed-hook and synthetic UI/API proof.
- [x] Document generic setup/API and limits; bump coherent next beta; publish under standing authorization.
- [x] Verify public files, packaged hooks/MCP/IPC, signing/notarization, record evidence, clean task-only fixtures.

Local integration: 558 tests passed before the final two review regressions; affected billing/integration suites (13 tests), generic MCP (16 tests) and final review (29 tests) passed afterward. Production build/typecheck and dependency audit passed. Local native-only build requires generated packaged sidecars; the signed release CI must complete native checks before publication.

Release complete: beta48 source 12b724d, run 43134740150; CI 560 JS and 33 native tests, real packaged MCP/copied-hook/context and billing IPC proofs, public hashes/signatures/notarization verified. Evidence in docs/beta/release-record.md.
