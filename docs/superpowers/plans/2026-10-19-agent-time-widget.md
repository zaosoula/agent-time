# Agent Time Desktop Widget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a native medium macOS widget showing today's Mac activity, agent time, and working agents.

**Architecture:** The collector's existing tray summary supplies the values. The host app writes a compact snapshot to a shared macOS app group; a WidgetKit extension reads it and refreshes on a bounded timeline. The extension is embedded in the Tauri bundle and signed separately from the Node sidecars.

**Tech Stack:** TypeScript collector, Rust/Tauri host, Swift/WidgetKit extension, Xcode build, Developer ID signing.

**Spec:** `docs/superpowers/specs/2026-10-19-agent-time-widget-design.md`

## Global Constraints

- Apple Silicon and macOS 13.5 or later.
- One medium widget; no collector or network in the widget.
- Snapshot semantics match My day and stale data is labeled.
- Keep signed DMG and OTA archive verification intact.
- Preserve unrelated `beta-feed/README.md` and `beta-feed/upload.mjs` changes.

## Review Focus

- A missing snapshot shows setup guidance.
- A prior-day snapshot never appears as today's totals.
- A stopped app does not leave an apparently live agent count.
- A zero-activity day displays zero values, not an error.
- Signing and packaging retain valid nested extension entitlements.

---

### Task 1: Publish a bounded daily snapshot

**Files:** Modify `src/capture/collector.ts`, `src-tauri/src/tray.rs`; create `native/WidgetSnapshot.swift` and focused tests.

**Interfaces:** `tray_status` gains `date` and `workingAgents`; the native snapshot writer accepts that JSON result and writes `date`, `updatedAt`, `available`, `running`, `humanSeconds`, `agentSeconds`, and `workingAgents` to the app group.

- [x] Add tests for current working-agent count, paused state, and snapshot payload validation.
- [x] Add the count to the existing collector summary and publish it at a bounded rate from the tray refresh path.
- [x] Run focused tests and verify the shared snapshot locally.

### Task 2: Build the native widget

**Files:** Create `native/widget/` WidgetKit source, extension metadata, Xcode project, and app-group entitlements.

**Interfaces:** The widget reads Task 1's snapshot; one `systemMedium` widget opens its containing app on click.

- [x] Add tests for missing, stale, prior-day, and zero-value snapshots.
- [x] Implement timeline provider and medium layout with update time and stale guidance.
- [x] Build the extension for arm64 macOS 13.5 and inspect its Info.plist.

### Task 3: Package and verify signed releases

**Files:** Modify sidecar/build scripts, Tauri bundle configuration, beta signing configuration, release checks, and relevant tests.

**Interfaces:** The installed app contains a signed `Contents/PlugIns/AgentTimeWidget.appex`; host and widget can access the same group without changing collector storage.

- [x] Embed the extension in local and beta builds with separate entitlements.
- [x] Extend release checks to verify extension identity, entitlement, minimum OS, and inclusion in both installer and OTA archive.
- [x] Run project tests, build, and native checks. Installed-app widget discovery waits for the signed release candidate; the existing installed beta remains active for tracking.
