# Agent Time public beta release record

Status: **first-install DMG approved for public beta** by the release owner on 2026-10-16. The updater feed remains unpromoted. Update this record for each candidate with the exact commit, artifact hashes, and observed results.

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
| Beta update endpoint and access | `https://agent-time.ezyostudio.com/beta/latest.json` on Coolify; DNS and HTTPS respond, but the feed returns 404 until a signed update is promoted. External update testing remains pending. |
| Feedback contact and owner | `zao.soula@ezyostudio.com`; supplied by release owner on 2026-10-16. Feedback workflow remains untested. |
| Public withdrawal channel | The landing page and source repository can carry a notice; support email is `zao.soula@ezyostudio.com`. Incident communication has not been tested. |

## Candidate evidence

| Gate | Result |
| --- | --- |
| Revision and dependency check | Candidate built from `05f4c7ece29eff71a1623195d2eb19634be87b90` on 2026-10-16. Local `npm ci`, 167 JavaScript tests, interface build, and 7 locked Apple Silicon Rust release tests passed; CI for this revision pending. |
| Artifact URL and SHA-256 | Local DMG `102f0f0734020f0d857ce1405a24c8a9f34dd23a33ce093500739dcb3a07ef3b`; signed updater archive `4c4db8ed361613068a453b252b31dcfac0deaa2051d41d7489024bdb5b0002fa`. Candidate manifest staged outside Git; hosted URL and byte comparison pending. |
| Developer ID, Hardened Runtime, nested signatures | Passed local `beta:build` checks for app and all bundled Mach-O files on 2026-10-16. |
| Notarization, stapling, Gatekeeper, quarantine | Apple accepted app and DMG; both staple validations and local app Gatekeeper assessment passed 2026-10-16. Quarantined Finder download pending. |
| Clean Apple Silicon install without developer tools | Pending |
| First-run capture and permissions | Pending |
| In-app update between two signed versions | Pending |
| Failed update and recovery cases | Pending |
| 48–72 hour capture soak and limits | Pending |
| Privacy/support owner review | Release owner approved the existing data notice on 2026-10-16. Support workflow remains untested. |

Release owner decision: **offer the signed and notarized `0.2.0-beta.1` DMG now**, with the remaining clean Mac, first-run, update, recovery, and soak checks explicitly pending. The owner selected the MIT license and approved the data notice on 2026-10-16. Do not promote the updater manifest until its separate gates pass.

## Local implementation evidence — not release approval

On 2026-10-15, the isolated `beta/closed-beta` worktree passed `npm test` (163 tests), `npm run build`, `cargo test --locked --release --target aarch64-apple-darwin --manifest-path src-tauri/Cargo.toml` (7 tests), and `npm audit --omit=dev --audit-level=high` (0 reported vulnerabilities). Revision `289684c` also passed the separate Apple Silicon CI checks linked above: locked install, JavaScript tests, interface build, dependency audit, Swift sidecars, and locked Rust tests. A local **Apple Development signed** Apple Silicon smoke build produced an app, updater archive, and signature. Its bundle declares macOS 13.5, each Swift helper declares 13.5, and `codesign --verify --deep --strict` passed. This smoke build was not notarized, quarantined, installed on a second Mac, or used for an in-app update; it must not be distributed as the beta. Record the real release artifact hashes after final review.
