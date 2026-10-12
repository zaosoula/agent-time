# Orca agent time capture: validation design

## Purpose and first deliverable

Replace Timing with an independent local timesheet application. The user's primary work happens in Orca, with multiple agents in the same workspace, Orca CLI orchestration, and agent-native subagents. Capture must distinguish human time, agent execution intervals, and elapsed project activity.

The first deliverable is a runnable capture validation harness and an easy-to-read local evidence report, also viewable in a minimal Tauri desktop window. This phase proves ingestion and attribution before building the production dashboard. It does not install a persistent background service or change existing orchestration runs.

## Observed baseline, 2026-10-12

The repository starts without application code. Available tools are Python 3.14.7, Swift 6.4, Codex CLI 0.162.1, and Claude Code 2.1.296. System CLI versions do not establish the executable/version used by every Orca-managed account.

Read-only inspection of `orca orchestration worker-list --limit 100 --json` returned 100 workers, with more pages available. Every sampled row supplied Run, Task, Dispatch, terminal, and workspace identifiers. Several Run/workspace groups contained multiple distinct workers. Completed retained workers and `user_takeover` retention were observed. This sample proves grouping metadata availability, not historical duration accuracy or exhaustive fleet coverage.

`orca terminal list` exposes terminal handle, incarnation, workspace path, agent identity, and execution host. Those observations do not yet establish a provider session-ID join.

Agent Session History is enabled and indexes Claude and Codex; its reported degradation concerns an unavailable Gemini directory. Its search interface is not assumed to be a complete event export.

A read-only Swift probe returned a foreground app and Accessibility trust for the probe process. Idle reads using the null event type produced a misleading large value. Using the all-event sentinel, `CGEventType(rawValue: UInt32.max)`, returned approximately 0.28 seconds, consistent with recent mouse activity. Accessibility trust for this process does not guarantee permission for a future signed collector. Foreground-session attribution remains untested.

## Scope

Implement one narrow path: observe Orca metadata, receive minimal provider hook events, observe local foreground/idle signals, correlate these into bounded intervals, and render a local evidence dashboard in Tauri with proof status and standalone HTML export. Include deterministic replay tests and a small controlled live orchestration exercise.

Defer billing, cloud sync, full application tracking, screenshots/OCR, AI summaries, pricing calculations, and polished dashboard UI. Retain manual attribution as a future product requirement; ambiguous intervals in the harness remain unresolved.

## Architecture

Use TypeScript on Node.js 26.9+ for CLI orchestration, SQLite persistence through node:sqlite, correlation, replay tests, and reporting. Use a small native Swift helper for macOS foreground, input inactivity, and sleep/wake observations. Present the validation dashboard using TypeScript, Vue 3, and Vite inside Tauri 2. Keep the Rust shell limited to window lifecycle, restricted IPC, and managing the Node/Swift processes. Tauri uses a native webview and does not supply a Node runtime; bundle the collector runtime and helper for a packaged app. A native collector is required because a web dashboard alone cannot supply OS activity signals.

Provider hooks append minimal events to a private local spool and immediately return success without model-facing output. The collector imports spool records into SQLite with deduplication. Collection failure must not block, interrupt, or add context to an agent. Hook installation is explicit and reversible; preserve existing configurations and resolve the actual configuration root for each Orca account before modifying it.

Poll documented Orca read APIs at a configurable interval, default five seconds. Fully traverse worker pagination; preserve host-scope omissions and collection failures. A sampled status transition has a bounded timing uncertainty, not an exact transition timestamp. The collector never consumes or acknowledges an orchestration inbox and never executes suggested next actions.

Transcript ingestion is a recovery adapter only where schemas and paths have been verified. Original transcript contents are not copied into the evidence store.

The desktop window is a consumer of the capture core, never its event source. Closing the window hides it while the app process continues collection; explicitly quitting flushes and stops its owned collector/helper. Hooks can keep spooling while the application is quit; continuous macOS tracking while quit requires a future separately installed service and is outside this phase. Reopening the dashboard must not start another collector.

Use a fixed JSON-lines protocol over managed child-process stdin/stdout. The Rust bridge exposes only capture status, a summary query, and bounded capture controls; frontend callers cannot supply executable paths, shell commands, or arbitrary database paths. Runtime logs go to stderr. The SQLite writer is owned by the collector. Keep a frontend transport interface so the dashboard can later support a browser deployment, but do not expose a browser HTTP server in this phase.

A development run using installed Node is not evidence that a packaged app is self-contained. Verify an unsigned local app bundle with its own Node runtime and Swift helper separately; signing/notarization and distribution are outside this phase. Record the identity/permissions of the actual helper in that bundle.

## Identity and grouping

Persist source, source timestamp where available, observation timestamp, host/runtime, workspace identity, terminal handle/incarnation, provider, provider session ID, turn ID, parent relationship, Run ID, Task ID, and Dispatch ID. Optional fields stay absent rather than being fabricated.

Use workspace/project for navigation and Run for coordinated work. Tasks contain Dispatch attempts. Associate agent sessions and turns to attempts through time-bounded relationships. Runs can span workspaces; workspaces can contain several Runs. A provider session or terminal can be reused by successive attempts. A Dispatch may have multiple associated provider sessions after a resume or restart.

Correlate explicit IDs first, then verified terminal/process bindings. A working directory alone is insufficient when multiple agents share it. Unproven matches are unresolved with evidence describing candidate associations. Terminal handles alone are not durable across restarts; retain incarnation and execution host. Folder workspaces are supported without Git.

Orca-managed workers and provider-native subagents are separate relationship types. Native subagent hooks may share a root session ID: preserve the provider agent ID, parent session, and turn context. Do not add parent inclusive runtime to child runtime in a single combined total. Show root-session wall time and child detail separately unless exclusive intervals are available.

## Time semantics

Human time is a foreground-activity estimate. Attribute to a focused agent only when the selected session is observable; otherwise keep workspace-level or unassigned activity. Use a configurable idle threshold, initially five minutes, retaining underlying observations so later correction is possible. Lack of input can mean reading or thinking. If inactivity becomes implausible or unavailable, mark the interval unknown rather than silently declaring idle.

Agent time is observed turn execution wall time, not CPU time. Track observed running, known waiting, complete, interrupted, and unknown states separately. Prompt submission is not proof execution began. A Stop callback is not automatically accepted task settlement, particularly when other hooks can continue the agent. Reconcile provider events with orchestration outcomes and later activity.

Completion stops time for that attempt even when its terminal remains retained. User takeover and follow-up Dispatches create new association intervals. Terminal lifetime is never used as task duration. Missing final events, stale observations, sleep, collector downtime, and remote contact loss do not imply continued activity or process exit.

Project elapsed activity is the union of recorded intervals. Human intervals are counted once. Concurrent independent agent sessions may contribute multiple agent-hours, clearly labeled. Every derived interval carries observed, inferred, or unresolved proof status and its source evidence.

## Validation matrix

1. Multiple Orca workers in one workspace: distinct sessions and attempts, one Run group, correct combined elapsed interval.
2. Two Runs in the same workspace: no cross-group attribution.
3. Native subagents: explicit parent-child mapping or an honest unsupported/unresolved verdict; no inflated combined runtime.
4. Retry and follow-up in the same terminal: separate Dispatch intervals; no activity leaking into an earlier attempt.
5. Coordinator question/wait: known waiting is separated when evidence supplies boundaries; absence of a message is not a wait event.
6. Completion plus retained terminal and user takeover: closed attempt duration stays closed; later work is separately attributed.
7. Restart/disconnection and missing completion: uncertainty preserved; no overnight runtime accumulation. Remote coverage is explicitly reported.
8. Foreground switching, inactivity, and reading: human time counted once; session attribution has measured capability status.
9. Duplicate/reordered hook events and replayed metadata: idempotent storage, deterministic derived intervals, no negative duration.
10. Hook failure and configuration rollback: provider continues normally; original settings restored without removing unrelated hooks.

Use synthetic fixtures for reproducible arithmetic and edge cases, clearly labeled simulated. Live proof is separately labeled and names the actual versions and observed signals. Remote restart and provider features that cannot be exercised locally remain unverified rather than inheriting fixture proof.

## Controlled live exercise

Use a dedicated test Run in this workspace and read-only worker tasks, with bounded prompts and no repository edits. Discover exact supported commands and account roots before launch. Observe all initial workers before waiting. Follow Orca's lifecycle contract for any workers launched: accept settlement, then release or explicitly retain as appropriate. Never use unrelated active runs as the target of a lifecycle mutation.

The collector records the coordinator and workers, including any native subagent exercise supported by the tested provider. Compare reported relationships against launch receipts and provider hook identifiers. Controlled agent work incurs ordinary model usage; it is limited to validation tasks.

## Evidence report and acceptance

Generate standalone local HTML with workspace/Run/task/session grouping, human and agent intervals, overlap-aware totals, and a validation table. Escape all input text. Display missing coverage and unresolved relationships next to the affected data. Store generated evidence and databases outside tracked source paths and keep transcript/prompt content out of fixtures.

Accept this phase only when deterministic grouping/duration tests pass, live same-workspace Orca grouping is observed end to end, at least one provider hook is correlated to its actual session, and macOS foreground/idle observation is verified. Every remaining matrix item must have a pass, fail, unsupported, or unverified verdict with evidence. An unresolved core session join means the capture architecture needs revision before dashboard implementation.

## Source references

- Installed version-matched `orca-cli` and `orchestration` guides, read through `orca skills get`.
- Claude hooks: https://code.claude.com/docs/en/hooks
- Codex hooks: https://learn.chatgpt.com/docs/hooks
- Apple foreground notification: https://developer.apple.com/documentation/appkit/nsworkspace/didactivateapplicationnotification
- Apple inactivity API: https://developer.apple.com/documentation/coregraphics/cgeventsource/secondssincelasteventtype(_:eventtype:)
- Apple Accessibility API: https://developer.apple.com/documentation/applicationservices/axuielement

- Tauri architecture: https://v2.tauri.app/concept/architecture/
- Tauri sidecars: https://v2.tauri.app/develop/sidecar/
- Node SQLite: https://nodejs.org/api/sqlite.html
