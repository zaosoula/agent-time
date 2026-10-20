# Agent Time public beta release record

## Tracking reliability work — 2026-10-20, unreleased

Branch `feat/tracking-reliability-roadmap` contains per-source capture states including browsers, bounded collector restart, targeted hook repair, first-event setup feedback, privacy exclusions that discard browser samples when a site exclusion cannot be checked, timed pause, bulk daily review, manual notes, weekly review/export, an opt-in redacted JSON support bundle, verified SQLite archive import and explicit deletion, storage breakdown and WAL reclamation, background update checks, and a widget route to capture health. Local verification passed 211 JavaScript tests, 14 locked Rust tests, the interface build, an Apple Silicon app build, strict nested signature verification, and packaged `agenttime` URL scheme inspection. That app build used local development signing and was **not notarized or published**. The current public beta remains `0.2.0-beta.4`.

On a read-only local store with 558,638 events and a 434,417,664-byte database, the new indexed startup settings query read 179 relevant records in about 1 ms; the prior startup code loaded and parsed all events. The offline compactor verified a disposable copy with 516,870 events and 413,798,400 bytes, preserving timing, other coverage, review decisions, integrity, and the static Orca host-scope notice on all nine observed days. The copy saved 20,619,264 bytes (about 4.7%) and was deleted after measurement. Full summary replay still takes about 3 seconds and is a release performance limitation. A shorter date window happened to match sampled days but was not shipped because a valid observed span may cross its boundaries. No live history retention or deletion was introduced.

Before a new public version: complete safe daily projection work, build a versioned Developer ID signed and notarized candidate on Apple Silicon, verify widget deep-link navigation and timed pause on a real install, and record clean-Mac first run plus actual signed OTA update/recovery. Do not promote this branch's development build or change the public feed based on local tests alone.

Status: **`0.2.0-beta.4` published on 2026-10-19** with a macOS daily summary widget and refreshed app icon. The public site offers its signed and notarized Apple Silicon DMG, and the HTTPS updater feed serves its signed update. Clean-Mac installation, visual widget gallery confirmation, Mac mini confirmation, and end-to-end OTA results are still pending.

## Release contract

| Item | Decision or evidence |
| --- | --- |
| Product and bundle ID | Agent Time, `studio.ezyo.agenttime` |
| First candidate | `0.2.0-beta.1` |
| Architecture | Apple Silicon, `aarch64-apple-darwin` only |
| Minimum macOS | Provisional build floor `13.5` from bundled Node; pending clean-machine test before claiming support |
| Initial install | Public Developer ID signed and notarized DMG after the release owner selects its version |
| Later updates | Signed in-app update over HTTPS, `darwin-aarch64` manifest entry; no routine replacement downloads |
| Signing identity and team | Developer ID Application: EZYOSTUDIO (`XSA5KG6XNB`) signed the local candidate on 2026-10-16. Certificate expires 2027-02-01. |
| Notary credentials | EzyoStudio team API key authenticated with `xcrun notarytool history`; Apple accepted both the app and DMG on 2026-10-16. Private key is outside Git with user-only file permissions. |
| Updater key custody and backup | Private key generated in a user-only local folder outside Git on 2026-10-16; release owner confirmed a password-manager backup. End-to-end in-app signature acceptance remains pending. |
| Beta update endpoint and access | `https://agent-time.ezyostudio.com/beta/latest.json` on Coolify. Deployment `tvk0vltj71bkops4n4y66vbk` from `12b0b7f` changed the empty feed to HTTP 204. The 2026-10-19 publication record below identifies `0.2.0-beta.4` as the promoted version for `darwin-aarch64`. External in-app update testing remains pending. |
| Feedback contact and owner | `zao.soula@ezyostudio.com`; supplied by release owner on 2026-10-16. Feedback workflow remains untested. |
| Public withdrawal channel | The landing page and source repository can carry a notice; support email is `zao.soula@ezyostudio.com`. Incident communication has not been tested. |

## Candidate evidence

| Gate | Result |
| --- | --- |
| Revision and dependency check | Candidate built from `05f4c7ece29eff71a1623195d2eb19634be87b90` on 2026-10-16. Local `npm ci`, 167 JavaScript tests, interface build, and 7 locked Apple Silicon Rust release tests passed; CI for this revision pending. |
| Artifact URL and SHA-256 | Local and publicly downloaded DMG `102f0f0734020f0d857ce1405a24c8a9f34dd23a33ce093500739dcb3a07ef3b` at `https://agent-time.ezyostudio.com/install/0.2.0-beta.1/Agent%20Time_0.2.0-beta.1_aarch64.dmg`; signed updater archive `4c4db8ed361613068a453b252b31dcfac0deaa2051d41d7489024bdb5b0002fa`. Candidate manifest staged outside Git; hosted updater archive and signature comparison pending. |
| Developer ID, Hardened Runtime, nested signatures | Passed local `beta:build` checks for app and all bundled Mach-O files on 2026-10-16. |
| Notarization, stapling, Gatekeeper, quarantine | Apple accepted app and DMG; both staple validations and local app Gatekeeper assessment passed 2026-10-16. Quarantined Finder download pending. |
| Clean Apple Silicon install without developer tools | Pending |
| First-run capture and permissions | Pending |
| In-app update between two signed versions | Pending |
| Failed update and recovery cases | Pending |
| 48–72 hour capture soak and limits | Pending |
| Privacy/support owner review | Release owner approved the existing data notice on 2026-10-16. Support workflow remains untested. |

Release owner decision: **offer the signed and notarized `0.2.0-beta.1` DMG now**, with the remaining clean Mac, first-run, update, recovery, and soak checks explicitly pending. The owner selected the MIT license and approved the data notice on 2026-10-16. Do not promote the updater manifest until its separate gates pass.

## First-run incident — 2026-10-19

Two testers reported that capture stayed in “Checking…” and the collector exited; one also reported that the window could not be moved. The app showed an update-check error. The exact public `beta.1` DMG (SHA-256 above) reproduced the collector crash on the release Mac: its Hardened Runtime signed Node sidecar terminated before loading the collector with `Failed to reserve virtual memory for CodeRange`. A local copy signed with only `com.apple.security.cs.allow-jit` started the packaged collector from an isolated home directory. The `main` window capability lacked `core:window:allow-start-dragging`, which Tauri requires for the existing drag regions. The unpromoted update endpoint returned 404; the updater accepts 204 as “no update.”

The installer selection was removed from the public landing page through the feed service on 2026-10-19. The page remained online and direct installer requests for the withdrawn version returned 404. The earlier signed/notarized status alone did not prove runtime function.

## `0.2.0-beta.2` staged candidate — 2026-10-19

GitHub Actions [run 39246093682](https://github.com/zaosoula/agent-time/actions/runs/39246093682) built commit `12b0b7ff616df23a4abd4cdf1f01252026e699b1` on Apple Silicon. Its candidate checks, Developer ID signing, notarization, stapling, bundled collector smoke check, checksum staging, and private artifact upload passed. The `publish` job was skipped. The downloaded artifact contains the DMG with SHA-256 `3235962252f1a62bd0bb65a0ca7445bac504a2a2fc6d9813c1d4d9a6d4a5171b` and updater archive with SHA-256 `7e3a32e439e79cf847453c6e01b7bb2004d82b0635c9e8a1b68237787e554e62`; both match its staged metadata. The DMG was mounted read-only on the release Mac, and its bundled Node returned a valid collector `status` response using a fresh temporary home directory. This directly checks the `beta.1` crash path.

At that staging point, the public site said the installer was being prepared and the live feed returned 204. That candidate was not published; the later release below has different artifact hashes. Finder installation with quarantine, interactive first-run permissions and window dragging, hook event capture in a new agent session, in-app update, recovery, and soak testing remained unverified.

## `0.2.0-beta.2` public release — 2026-10-19

The release owner explicitly requested publication. GitHub Actions [run 39251971042](https://github.com/zaosoula/agent-time/actions/runs/39251971042) built commit `c942b8c47ff37caf0d6001071e5991d78e81ec4a` on Apple Silicon. Candidate checks, Developer ID signing, notarization, stapling, the bundled collector smoke check, artifact staging, and protected publication all passed. The public [DMG](https://agent-time.ezyostudio.com/install/0.2.0-beta.2/Agent%20Time_0.2.0-beta.2_aarch64.dmg) was downloaded independently and matched the staged SHA-256 `aeeb2d2e086d437b6305bbcfa1c96aa30c81dfcca218cb98533d7bd3b00e1c62`. The updater archive SHA-256 is `d2446de684a1711b035746d888d552887a10f54e0b40095109243aaf57ed62df`.

The public landing page displays `0.2.0-beta.2` and links to that DMG. The live update feed reports `0.2.0-beta.2` for `darwin-aarch64` with a signature. The release includes the collector JIT entitlement, window dragging permission, empty-feed handling, completed hook-setup action, and a one-time Accessibility guidance dialog after hook setup. The owner chose to publish while clean-Mac Finder installation, interactive Accessibility and hook setup, an actual `beta.1` to `beta.2` in-app update, recovery, and soak testing remain pending. Testers should report those first-run results.

## `0.2.0-beta.3` public release — 2026-10-19

A Mac mini without Orca reported `spawn orca ENOENT`. Commit `0a667aaf916d0c367a369b40ea5bbdc88b3d59d8` detects whether the configured Orca command is executable before polling runs, fetching terminal layouts, or reading Orca account limits. When it is unavailable, Orca discovery is skipped and shown as optional; Mac activity, agent hooks, and local token history remain active. The preference remains saved so discovery can resume if Orca becomes available later. A focused no-Orca test confirmed that a Codex hook event is captured with no Orca event or collector error. Local checks passed: 175 JavaScript tests, the UI build, version consistency, and 7 locked Rust tests.

GitHub Actions [run 39255235488](https://github.com/zaosoula/agent-time/actions/runs/39255235488) passed Apple Silicon build, signing, notarization, packaged collector smoke check, artifact staging, and protected publication. The public [DMG](https://agent-time.ezyostudio.com/install/0.2.0-beta.3/Agent%20Time_0.2.0-beta.3_aarch64.dmg) was independently downloaded and matched SHA-256 `3c8eb3947ab841284338e32b23933d398897e43740b29534a799639948bf0871`. The public updater archive matched SHA-256 `81a2d582fca5dab950790c256c0c8b301a64bb083a82304eb12e0587d143761e`. The landing page and live signed feed report `0.2.0-beta.3` for Apple Silicon. Actual update completion and capture on the affected Mac mini remain to be confirmed.

## `0.2.0-beta.4` local candidate — 2026-10-19

Commit `db74c586586d5b1f2222da3a219815552822cee0` adds a medium macOS widget showing today's Mac activity, agent time, and working agents, plus a refreshed app icon. The widget receives a bounded snapshot through the signed `widget-snapshot` sidecar and shared app group, displays an unavailable state when capture stops, and rejects the previous day's totals. The icon source, preview, and macOS renders are in `assets/agent-time-icon/`. The installed icon assets and widget extension were reviewed at full and small sizes.

Local checks passed: 177 JavaScript tests, interface build, 8 locked Rust tests, widget/host version and entitlement checks, nested signing, updater archive contents, Apple notarization and stapling, and Gatekeeper assessment. The signed local DMG SHA-256 is `3c425b3e46c85a7245bec1e126fc1153ed6608640bb98d70a0fe831b97b4e116`; the signed updater archive SHA-256 is `0fee50c48c80886624528240bb976dd4ba3f3aa53ed9a26a6ee940548de7e6e4`. Both are staged outside Git under `.capture/release-beta4/` and have **not** been published.

The notarized DMG was mounted and its app installed at `/Applications/Agent Time.app` on the release Mac. The app and collector started, macOS registered `studio.ezyo.agenttime.widget(0.2.0-beta.4)`, and the app-group snapshot reported a current-day available summary. The widget's visual rendering in the macOS widget gallery is unverified because the available computer-control route could not read the gallery. Clean-Mac installation, external first run, and actual OTA update/recovery remain pending. GitHub Actions [build-only run 39280113062](https://github.com/zaosoula/agent-time/actions/runs/39280113062) was requested from the exact candidate commit but remained queued behind an older run waiting at `beta-signing` at publication time.

The release owner requested beta.4 publication on 2026-10-19. The exact locally signed, notarized, and staged candidate was uploaded through the authenticated feed service using `scripts/ci-publish-beta.mjs` with its version and source revision checked. The live [update manifest](https://agent-time.ezyostudio.com/beta/latest.json) and landing page report `0.2.0-beta.4`. Independent public downloads matched the staged SHA-256 for both the [DMG](https://agent-time.ezyostudio.com/install/0.2.0-beta.4/Agent%20Time_0.2.0-beta.4_aarch64.dmg) (`3c425b3e46c85a7245bec1e126fc1153ed6608640bb98d70a0fe831b97b4e116`) and updater archive (`0fee50c48c80886624528240bb976dd4ba3f3aa53ed9a26a6ee940548de7e6e4`). This publication used the locally validated artifact because the protected GitHub build had not started; it does not establish GitHub runner or end-to-end OTA proof.

## Public download verification — 2026-10-16

Coolify deployment `epf87gppslbpv3nurx3ij7fb` finished with source commit `6a48ab941d0b59cea5c32e014cefae1c93b14cc0`; the service reported healthy. The HTTPS landing page returned 200 with the public download link, data notice, source, and MIT license links. A full unauthenticated GET of the DMG matched the local SHA-256 above. The update feed still returned 404, as intended while OTA validation is pending. This verifies hosting and bytes, not a clean Mac installation or a successful in-app update.

## Local implementation evidence — not release approval

On 2026-10-15, the isolated `beta/closed-beta` worktree passed `npm test` (163 tests), `npm run build`, `cargo test --locked --release --target aarch64-apple-darwin --manifest-path src-tauri/Cargo.toml` (7 tests), and `npm audit --omit=dev --audit-level=high` (0 reported vulnerabilities). Revision `289684c` also passed the separate Apple Silicon CI checks linked above: locked install, JavaScript tests, interface build, dependency audit, Swift sidecars, and locked Rust tests. A local **Apple Development signed** Apple Silicon smoke build produced an app, updater archive, and signature. Its bundle declares macOS 13.5, each Swift helper declares 13.5, and `codesign --verify --deep --strict` passed. This smoke build was not notarized, quarantined, installed on a second Mac, or used for an in-app update; it must not be distributed as the beta. Record the real release artifact hashes after final review.
