# Agent Time public beta release record

Status: **`0.2.0-beta.1` installer withdrawn on 2026-10-19 after first-run failures**. The updater feed remains unpromoted. The signed and notarized `0.2.0-beta.2` repair candidate is staged in a private GitHub Actions artifact; it is not offered on the public site. Update this record for each candidate with the exact commit, artifact hashes, and observed results.

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
| Updater key custody and backup | Private key generated in a user-only local folder outside Git on 2026-10-16; release owner confirmed a password-manager backup. Update signature verification remains pending. |
| Beta update endpoint and access | `https://agent-time.ezyostudio.com/beta/latest.json` on Coolify; the unpromoted feed returned 404 in `beta.1`, which the installed updater displayed as an error. Deployment `tvk0vltj71bkops4n4y66vbk` from `12b0b7f` finished on 2026-10-19 and the live endpoint now returns 204 when no update exists. External update testing remains pending. |
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

The installer selection was removed from the public landing page through the feed service on 2026-10-19. The page remains online and direct installer requests for the withdrawn version return 404. `beta.2` must prove a fresh-profile collector start, hook setup, window dragging, signed and notarized artifacts, and the update path before public selection. The earlier signed/notarized status alone did not prove runtime function.

## `0.2.0-beta.2` staged candidate — 2026-10-19

GitHub Actions [run 39246093682](https://github.com/zaosoula/agent-time/actions/runs/39246093682) built commit `12b0b7ff616df23a4abd4cdf1f01252026e699b1` on Apple Silicon. Its candidate checks, Developer ID signing, notarization, stapling, bundled collector smoke check, checksum staging, and private artifact upload passed. The `publish` job was skipped. The downloaded artifact contains the DMG with SHA-256 `3235962252f1a62bd0bb65a0ca7445bac504a2a2fc6d9813c1d4d9a6d4a5171b` and updater archive with SHA-256 `7e3a32e439e79cf847453c6e01b7bb2004d82b0635c9e8a1b68237787e554e62`; both match its staged metadata. The DMG was mounted read-only on the release Mac, and its bundled Node returned a valid collector `status` response using a fresh temporary home directory. This directly checks the `beta.1` crash path.

The public site currently says the installer is being prepared. The live feed returns 204, and the withdrawn `beta.1` installer URL returns 404. Finder installation with quarantine, interactive first-run permissions and window dragging, hook event capture in a new agent session, in-app update, recovery, and soak testing remain unverified. Do not treat the private artifact as a published update.

## Public download verification — 2026-10-16

Coolify deployment `epf87gppslbpv3nurx3ij7fb` finished with source commit `6a48ab941d0b59cea5c32e014cefae1c93b14cc0`; the service reported healthy. The HTTPS landing page returned 200 with the public download link, data notice, source, and MIT license links. A full unauthenticated GET of the DMG matched the local SHA-256 above. The update feed still returned 404, as intended while OTA validation is pending. This verifies hosting and bytes, not a clean Mac installation or a successful in-app update.

## Local implementation evidence — not release approval

On 2026-10-15, the isolated `beta/closed-beta` worktree passed `npm test` (163 tests), `npm run build`, `cargo test --locked --release --target aarch64-apple-darwin --manifest-path src-tauri/Cargo.toml` (7 tests), and `npm audit --omit=dev --audit-level=high` (0 reported vulnerabilities). Revision `289684c` also passed the separate Apple Silicon CI checks linked above: locked install, JavaScript tests, interface build, dependency audit, Swift sidecars, and locked Rust tests. A local **Apple Development signed** Apple Silicon smoke build produced an app, updater archive, and signature. Its bundle declares macOS 13.5, each Swift helper declares 13.5, and `codesign --verify --deep --strict` passed. This smoke build was not notarized, quarantined, installed on a second Mac, or used for an in-app update; it must not be distributed as the beta. Record the real release artifact hashes after final review.
