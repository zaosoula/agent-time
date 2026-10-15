# Agent Time Closed Beta Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a private, installable macOS beta that captures honestly, protects local data, survives an update, and gives testers a clear support path.

**Architecture:** Keep the existing Tauri host, Node/SQLite collector, Swift helper, and one-file source modules. Add a separate distribution build path and a small support surface around the current capture workflow. Keep beta artifacts and credentials outside the repository.

**Tech Stack:** Tauri 2, Rust, Node 26, TypeScript/Vue, Swift, SQLite, Apple Developer ID signing, Apple notarization.

**Spec:** [`../specs/2026-10-15-agent-time-closed-beta.md`](../specs/2026-10-15-agent-time-closed-beta.md)

## Current evidence and decisions

- `scripts/build-desktop.mjs` makes a local Apple Development signed `.app` and sets `hardenedRuntime:false`; `README.md` explicitly excludes notarization. No Developer ID Application identity is currently present on this Mac. This is the first external distribution blocker.
- `src-tauri/tauri.conf.json` and `package.json` are at `0.1.0`. The latest local bundle reports `LSMinimumSystemVersion=10.13` although the tested build is Apple Silicon on macOS 26.6.2. The supported floor needs an actual clean-machine test.
- The package includes Node, Swift and startup helpers. `scripts/package-sidecars.mjs` builds for the current host architecture. There is no updater, beta feedback destination, privacy notice, or release workflow in the repository; `.github/workflows/pricing.yml` is unrelated to app releases.
- `docs/capture-validation.md` proves a narrow live Claude/Orca join and a packaged preview. It explicitly leaves actual Codex delivery, remote hosts, sustained capture, and exact human attribution unproven. `docs/code-audit-2026-10-14.md` records growing database/replay cost, so a beta soak must measure it.
- **Recommended first cohort:** 5–10 invited Apple Silicon testers using direct notarized downloads and manual announced updates. The owner can widen architecture or distribution scope after the first gate. Do not describe the current development signed `.app` as a distributable beta.

## File map

| File | Responsibility |
| --- | --- |
| `scripts/build-desktop.mjs` | Keep the existing local development build distinct from release. |
| `scripts/build-beta.mjs` and `src-tauri/tauri.beta.conf.json` | Refuse development signing, build both the `.app` and a downloadable container, sign nested executables, notarize, staple, and verify. |
| `src-tauri/entitlements/` | Hold the minimum proven Hardened Runtime exception for the embedded Node executable, if one is needed. |
| `src-tauri/tauri.conf.json`, `package.json`, `src-tauri/Cargo.toml`, lockfiles | Agree on beta version and supported target. |
| `src/capture/diagnostics.ts`, `src/capture/protocol.ts`, `src/ui/CaptureHealth.vue` | Offer an explicit, redacted diagnostic summary for private support. |
| `docs/beta/` | Privacy notice, installation, verification, updates, removal, known limitations, feedback and incident runbook. |
| `.github/workflows/beta-checks.yml` | Run deterministic checks and archive their results without release credentials. |

## Task 1 — Lock the release contract

- [ ] Record the first cohort's architecture and macOS versions. If Intel is required, make an `x86_64-apple-darwin` build on a corresponding runner/Mac and add it to every later gate; otherwise mark the first beta Apple Silicon only.
- [ ] Obtain a Developer ID Application signing identity and notary credentials through the release owner; keep them in Keychain or protected CI secrets. Do not place certificate exports, passwords, API keys, or provisioning material in Git.
- [ ] Choose a monitored private feedback destination and a person responsible for acknowledging reports. Prepare a way to contact all invited testers if a build must be withdrawn.
- [ ] Pick the first beta version above `0.1.0` and synchronize the Tauri, npm, and Cargo versions. Confirm that the bundle ID stays `studio.ezyo.agenttime` through upgrades.
- [ ] Gate: write these decisions into `docs/beta/release-record.md`. A missing signing identity or feedback route blocks invitations; it does not block local development.

## Task 2 — Produce and verify the external macOS artifact

- [ ] Add a separate `scripts/build-beta.mjs`; preserve `scripts/build-desktop.mjs` for local builds. Make the beta script reject an identity whose name is not `Developer ID Application`, missing notarization credentials, a disabled Hardened Runtime, or an unsigned nested executable.
- [ ] Build with Hardened Runtime and sign the Tauri executable plus bundled Node, activity helper, Keychain helper, startup helper, and any runtime loaded from the bundle. Start with no Runtime exceptions; if Node fails, test the narrow JIT/unsigned executable memory entitlement on Node only and record why it is needed. Do not disable Hardened Runtime for the distribution build.
- [ ] Build a DMG or ZIP that preserves the signed app. Submit that exact container with `xcrun notarytool`, wait for acceptance, staple where supported, and record its SHA-256. Preserve the notary submission ID and log outside the app bundle.
- [ ] Verify the final artifact with the following checks and inspect every nested executable's identity and entitlements:

  ```sh
  codesign --verify --deep --strict --verbose=2 'Agent Time.app'
  xcrun stapler validate 'Agent Time.app'
  spctl --assess --type execute --verbose=4 'Agent Time.app'
  shasum -a 256 'Agent Time Beta.dmg'
  ```

- [ ] Download the artifact through the proposed tester route on a clean, quarantined Apple Silicon Mac. Do not remove quarantine or use a developer override. Open it from Finder without Xcode, Homebrew, or a system Node installation; verify Gatekeeper, the menu bar app, collector, helper, and a native outdated-hook notification. Record macOS version and actual minimum supported version, then correct the current `10.13` bundle claim.
- [ ] Gate: the exact download opens normally and all signatures, notarization, nested-helper, and fresh-machine checks pass. Apple requires Developer ID signing and Hardened Runtime for notarized direct distribution. [Apple notarization requirements](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution), [Tauri distribution guide](https://v2.tauri.app/distribute/).

## Task 3 — Prove first-run capture and clear onboarding

- [ ] On a clean tester-like account, follow only the published instructions. Verify first-run data disclosure, hook selection, Accessibility guidance, optional login item, and capture pause/quit behavior. Remove or correct any step that assumes shell access.
- [ ] Exercise one real Claude Code session and one real Codex session, including Codex trust review. For each, verify installed configuration, first received event, session attribution, idle/stop behavior, usage counters, and the outdated-hook repair path. Repeat through an Orca account home and with Orca unavailable.
- [ ] Exercise Safari, Chrome, and Brave enabled/disabled URL capture; verify that title/URL disclosure matches what SQLite stores. Check the explicit limitations when Accessibility is denied, Orca is absent, a browser's page URL is unavailable, or an agent session predates hook installation.
- [ ] Make `CaptureHealth.vue` lead the tester from “installed” to “received an event”, and from missing events to the relevant repair action. Keep the existing distinction between configured hooks and provider trust. Add focused tests only for newly changed status logic.
- [ ] Gate: every enabled source tested in the pilot has an observed end-to-end event or a visible, accurate limitation. Preserve the known unverified remote-host and billing boundaries from `docs/capture-validation.md`.

## Task 4 — Publish privacy, support, and removal materials

- [ ] Write `docs/beta/privacy.md` from the actual fields in `src/capture/events.ts`, `src/capture/macos.ts`, `src/usage/reader.ts`, and `src/capture/linear.ts`. Cover full local URL/title capture, project/cwd and agent IDs, token counts, storage locations, optional Linear OAuth, public pricing fetches, and absence of automatic history upload. Have the release owner review the notice before invitation.
- [ ] Add a “Copy diagnostic summary” action using `src/capture/diagnostics.ts` and restricted protocol/UI wiring. Include app/OS/architecture version, enabled-source states, hook installation states, recent-event ages, database size/health, and sanitized error categories. Exclude raw event payloads, page URL path/query, window/tab titles, project paths, credentials, and transcripts. Unit-test the output with sensitive fixture strings and assert none survive.
- [ ] Publish `docs/beta/install.md`, `docs/beta/update.md`, and `docs/beta/remove.md`. Show Finder installation, permission prompts, a sample captured event, how to pause and explicitly quit the menu bar app before replacing it, how to update manually, how to preview and remove Agent Time hooks/login item, and how to keep or delete local history. Never imply that closing the window quits capture or that deleting the `.app` removes user-wide hooks.
- [ ] Publish `docs/beta/known-limitations.md` and a private report template requesting version, OS, source, reproduction steps, expected/actual result, and the optional redacted summary. State that no prompt, transcript, raw database, or screenshot containing sensitive work should be attached by default.
- [ ] Gate: another person can complete setup, submit a safe report, and fully remove installed integrations using these instructions.

## Task 5 — Upgrade, recovery, and multi-day soak

- [ ] Produce two sequential Developer ID signed beta candidates with the same bundle ID and signing team. Install the first on a clean Mac, collect real events, enable hooks and optional login item, then upgrade to the second through the published update path. Check that SQLite events, settings, decisions, usage, hook ownership, Keychain entries, Accessibility state, and current Orca accounts remain intact. Confirm that changed hook runtime versions either work or show the existing repair warning. Treat a move from the existing Apple Development signed build as a separate migration that may require a fresh macOS permission grant.
- [ ] Trial rollback from the candidate to the prior build on a disposable copy of tester data. If old code cannot safely read the new database, document a forward-only update with backup and recovery steps instead of claiming rollback support.
- [ ] Run a 48–72 hour soak with app hide/reopen, sleep/wake, Orca disconnect/reconnect, agent restarts, and browser switching. Record event gaps, `PRAGMA quick_check`, database and WAL growth, collector peak RSS, summary response time, startup time, and notification behavior. Agree on limits before inviting the first external testers; do not add automatic data deletion to meet the limit.
- [ ] Gate: no corrupt history, duplicate hooks, stuck startup item, unbounded growth, or unexplained tracking gap. Separate observed capture from inferred time in the report.

## Task 6 — Repeatable beta delivery and pilot operation

- [ ] Add `.github/workflows/beta-checks.yml` for `npm ci`, `npm test`, `npm run build`, Rust tests, lockfile consistency, and a production dependency review. Keep signing/notary credentials out of pull-request jobs. Record exact commands and revisions in the release record.
- [ ] Create a private, versioned release entry with the notarized artifact, SHA-256, supported Mac/OS list, installation instructions, privacy notice, release notes, known limitations, support contact, and manual update instructions. Do not publish the artifact until all gates pass.
- [ ] Invite two internal testers on distinct Macs first. After both complete first run, one real agent event, pause/resume, and an update, invite the 5–10 person external pilot. Track each report to a release version, acknowledge it, and keep a stop/withdrawal contact list.
- [ ] For a later wider beta, decide whether to add Tauri's signature-checked updater and a private version feed. The first small pilot can use manual announced updates; automatic update work must include key custody, downgrade behavior, integrity tests, and recovery. [Tauri updater](https://v2.tauri.app/plugin/updater/).
- [ ] Gate: one person other than the builder can reproduce packaging from the release record, and one tester can install and upgrade without developer assistance.

## Review focus

- Does the notarized download launch its bundled Node and all helpers under Hardened Runtime without asking testers to bypass Gatekeeper?
- Can a tester distinguish “hook installed” from “agent event actually received,” especially after a provider update or Codex trust change?
- Does a release update preserve existing capture and hook ownership while a failed update leaves a recoverable state?
- Are the diagnostic summary and feedback process free of raw URLs, paths, prompts, credentials, and transcripts?
- Does the claimed minimum macOS version match an actual fresh-machine test rather than the generated `10.13` value?

## Final release decision

The release owner reviews a single gate record with artifact hash, code revision, signing/notary result, fresh-machine matrix, first-run evidence, upgrade result, soak measurements, privacy/support links, and known limits. **Do not invite beta testers until every gate is accepted.**
