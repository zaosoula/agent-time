# Agent Time Slate Design Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan in this session.

**Goal:** Apply the shared design and slate-blue icon to the existing application.

**Architecture:** Keep capture and store contracts intact. Add only a pure display-metric helper, update the overview and explorer components, and generate icons from a reproducible layered spec.

**Tech Stack:** Vue 3, TypeScript, CSS, Reka UI, Tauri/Rust, app-icon-gen.

**Spec:** `docs/superpowers/specs/2026-11-08-slate-design.md`

## Global Constraints

- Slate #7CAAD6, highlights #D3E6F8, human #FF963D, navy #142334; accessible light and dark variants.
- Preserve capture calculations and the separation of measured/reported work.
- Preserve unrelated changes; do not publish or install.

## Review Focus

- Empty days and human-only activity must not imply agent parallelism.
- Separated work periods must exclude idle gaps from average concurrency.
- Narrow chart labels and tooltips must remain within the viewport.
- Changing sessions must reset expanded lists and execution details.
- Keyboard focus must return after closing execution dialogs.

### Task 1: Timeline and theme

- [x] Add failing tests for a duration-weighted parallelism helper, including gaps and empty/human-only days; run them.
- [x] Implement the helper in `src/ui/overview-metrics.ts` and use it in `DayOverview.vue`.
- [x] Update `style.css`, overview cards/chart/controls/explanations, preserving zoom and project focus.
- [x] Run helper, viewport, project-explorer, and UI-bundle tests plus typecheck.

### Task 2: Project/session explorer

- [x] Improve project row hierarchy and session metrics copy.
- [x] Bound desktop lists and add mobile five-execution preview, full list dialog, and execution detail dialog using Reka UI.
- [x] Verify switching sessions, list expansion, keyboard navigation, and dialog dismissal in the browser.

### Task 3: Branding

- [x] Save the chosen reference in the generation directory and write the new layered icon spec.
- [x] Generate and verify source/preview/Apple output; inspect at full size and 64 px.
- [x] Wire sidebar/favicon/Tauri and monochrome tray assets; verify native compilation.

### Task 4: Acceptance

- [x] Run the full test suite and production build.
- [x] Inspect desktop/mobile, light/dark, populated/empty states, zoom, project focus, and dialogs.
- [x] Obtain a fresh final review; address material findings and report proof gaps accurately.

## Validation evidence

- `npm test`: 349 passing, zero failures (final full run).
- `npm run build`: vue-tsc and production Vite bundle passed.
- `cargo test --manifest-path src-tauri/Cargo.toml`: 26 passing, zero failures.
- App-icon-gen structural verification: valid assets and six macOS renders; no material warnings or failures.
- Orca browser: recent-activity snapshot from 7 November, desktop/light/dark and 390px mobile; no horizontal overflow. Verified 5-item mobile preview and all 59 executions in sheet, detail/back focus, Escape return focus, session arrow-key navigation, timeline zoom/reset, and project focus without collapsing explorer.
- Fresh independent code review: no Important or Critical findings.
- `git diff --check`: clean.

Implementation choice: retained clean vector geometry for the branching icon and used Icon Composer for native material. The generated reference board is design evidence; this is a semantic recreation, not a pixel-identical reproduction or the unavailable original 62-file pack. Source assets are reusable; the installed native app was not replaced or released.
