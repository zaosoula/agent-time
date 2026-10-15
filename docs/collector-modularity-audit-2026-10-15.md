# Collector modularity audit — 2026-10-15

## Current boundaries

`Collector` owns the capture lock, event store, settings history, polling loop, native probe lifecycle, hook spool import, usage reader, website matching, Linear connection, and report projection. It is a coordinator and several source implementations in one class. `orca.ts` and `macos.ts` contain useful decoders, but their lifecycle and attribution remain in `collector.ts`.

| Tracked source | Source-specific code outside its decoder | Effect of adding a source |
| --- | --- | --- |
| Orca workers and terminals | `collector.ts` polling and focus refresh; `settings.ts`; `correlate.ts`; `health.ts`; settings UI | A new metadata source must edit the coordinator and several projections. |
| Claude and Codex hooks | `hooks.ts` normalization; `hook-config.ts`; `hook-installation.ts`; `hook-runner.ts`; `collector.ts` acceptance; `settings.ts`; `correlate.ts`; `usage/parser.ts`; `usage/reader.ts`; `health.ts`; settings UI; TypeScript and Rust protocol guards | Adding an agent is spread across ingestion, installation, usage, security boundaries, and UI. |
| Safari, Chrome, and Brave page activity | `native/ActivityProbe.swift`; `collector.ts` flags; `settings.ts`; `macos.ts`; settings UI; TypeScript and Rust protocol guards | Adding a browser requires synchronized native, Node, and UI changes. Generic foreground activity already captures other apps without page URLs. |

## Target contract

Keep the lock, clock, event store, and scheduling in the coordinator. A source module should declare a stable ID, display metadata, default enablement, event normalization, and optional lifecycle capabilities (poll, native observation, hook installation, token logs). The framework should own settings validation, cancellation, health bookkeeping, and UI enumeration from these declarations. It must validate module IDs and event data before persisting them.

The one-file extension promise can apply to sources that fit an existing capability (for example, another browser using the generic accessibility URL reader, or another agent using the supported hook configuration format and JSONL token parser interface). A source with a new native accessibility strategy or a different hook installation format needs a new capability adapter as well. It should not be silently treated as supported by a display-only registry entry.

## Behavior to preserve

- Settings migration, per-provider disable fences, and rejection of invalid protocol input.
- Hook ownership records, cleanup preview, rollback, and copied runtime versioning.
- Orca Run, Task, Dispatch, terminal, and worktree attribution; never identify a session from cwd alone.
- Browser URL allowlisting and domain matching before storage.
- Usage import cursor semantics and provider-specific duplicate handling.
- Capture health and settings UI visibility for every enabled source.

## Refactor order

1. Introduce source descriptors and move the existing browser and agent declarations into one file per source. Keep compatibility with persisted settings and protocol parameters.
2. Move hook normalization/installation and usage parsing behind capabilities defined by those agent descriptors. Package descriptors with the copied hook runtime when needed.
3. Move Orca polling and macOS probe lifecycle out of `Collector`, preserving cancellation and lock semantics.
4. Generate settings, health, and UI lists from descriptors and prove that a fixture source is discovered without editing central switch statements.

The existing baseline is `7839c86` on local `main`: 148 Node tests, frontend typecheck, and 5 Rust tests passed before this refactor.
