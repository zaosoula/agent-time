# Agent Time closed beta release record

Status: **not approved for invitations**. Update this record for each candidate with the exact commit, artifact hashes, and observed results.

## Release contract

| Item | Decision or evidence |
| --- | --- |
| Product and bundle ID | Agent Time, `studio.ezyo.agenttime` |
| First candidate | `0.2.0-beta.1` |
| Architecture | Apple Silicon, `aarch64-apple-darwin` only |
| Minimum macOS | Provisional build floor `13.5` from bundled Node; pending clean-machine test before claiming support |
| Initial install | One private Developer ID signed and notarized download |
| Later updates | Signed in-app update over HTTPS, `darwin-aarch64` manifest entry; no routine replacement downloads |
| Signing identity and team | Developer ID Application: EZYOSTUDIO (`XSA5KG6XNB`) is installed with its private key in the release Mac Keychain; verified 2026-10-16. Certificate expires 2027-02-01. Signed release artifact remains pending. |
| Notary credentials | EzyoStudio team API key authenticated successfully with `xcrun notarytool history` on 2026-10-16; release artifact notarization remains pending. Private key is outside Git with user-only file permissions. |
| Updater key custody and backup | Private key generated in a user-only local folder outside Git on 2026-10-16; release owner confirmed a password-manager backup. Update signature verification remains pending. |
| Beta update endpoint and access | Planned `https://agent-time.ezyostudio.com/beta/latest.json` on Coolify; DNS and HTTPS respond, but the feed returns 404 until deployed. Tester-network access remains pending. |
| Feedback contact and owner | Pending owner choice; must be monitored before invitations |
| Withdrawal contact list | Pending invited-tester list; keep outside Git |

## Candidate evidence

| Gate | Result |
| --- | --- |
| Revision and dependency check | Implementation revision `289684c` passed [Apple Silicon CI checks](https://github.com/zaosoula/agent-time/actions/runs/38765239418) on 2026-10-15; actual signed candidate pending |
| Artifact URL and SHA-256 | Pending |
| Developer ID, Hardened Runtime, nested signatures | Pending |
| Notarization, stapling, Gatekeeper, quarantine | Pending |
| Clean Apple Silicon install without developer tools | Pending |
| First-run capture and permissions | Pending |
| In-app update between two signed versions | Pending |
| Failed update and recovery cases | Pending |
| 48–72 hour capture soak and limits | Pending |
| Privacy/support owner review | Pending |

Release owner decision: **hold** until every gate has dated evidence.

## Local implementation evidence — not release approval

On 2026-10-15, the isolated `beta/closed-beta` worktree passed `npm test` (163 tests), `npm run build`, `cargo test --locked --release --target aarch64-apple-darwin --manifest-path src-tauri/Cargo.toml` (7 tests), and `npm audit --omit=dev --audit-level=high` (0 reported vulnerabilities). Revision `289684c` also passed the separate Apple Silicon CI checks linked above: locked install, JavaScript tests, interface build, dependency audit, Swift sidecars, and locked Rust tests. A local **Apple Development signed** Apple Silicon smoke build produced an app, updater archive, and signature. Its bundle declares macOS 13.5, each Swift helper declares 13.5, and `codesign --verify --deep --strict` passed. This smoke build was not notarized, quarantined, installed on a second Mac, or used for an in-app update; it must not be distributed as the beta. Record the real release artifact hashes after final review.
