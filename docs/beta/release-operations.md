# Public beta release procedure

A release owner must complete [release-record.md](release-record.md) for every candidate. The GitHub workflow publishes automatically after a successful signed build when `publish: true` is selected; `publish: false` stages a private artifact only.

## Protected inputs

Run on Apple Silicon macOS with Node 26 and current Rust. Keep these outside Git and terminal transcripts:

- `APPLE_SIGNING_IDENTITY`: installed **Developer ID Application** identity, selected by hash or full name.
- Either `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH` for App Store Connect notarization, or `APPLE_ID`, `APPLE_PASSWORD` (app-specific), `APPLE_TEAM_ID` plus `APPLE_NOTARY_KEYCHAIN_PROFILE` for DMG notarization. Create and validate the Keychain profile with `xcrun notarytool store-credentials` before an Apple ID build.
- `TAURI_SIGNING_PRIVATE_KEY`: protected Tauri updater private key path or key content; optional `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Back up this key securely. Losing it prevents updates to installed apps.
- `BETA_UPDATER_PUBLIC_KEY`: exact contents of the Tauri updater public key, embedded in the beta build.
- `BETA_UPDATE_URL`: the public HTTPS beta manifest URL. The current setup expects a static `latest.json` with only `darwin-aarch64`.

Do not put the private key, notary key, passwords, or certificate export in the repository or GitHub pull-request jobs. The first beta version is `0.2.0-beta.1`; advance the npm, Tauri, Cargo, and lockfile versions together for every later candidate.

## GitHub Actions release path

The manually triggered [beta-release workflow](../../.github/workflows/beta-release.yml) runs on a GitHub Apple Silicon Mac. It checks the candidate, builds and verifies the Developer ID signed and notarized app and DMG, and saves the archive, signature, DMG, manifest, hashes, source commit, and release notes as a 14-day Actions artifact. It accepts only `main` and requires the version in npm, Tauri, Cargo, and both lockfiles to match the requested version. Its default `publish: false` run leaves the public download and OTA feed unchanged.

Create two GitHub environments before using the workflow:

- `beta-signing`: restrict deployments to `main`. Store `APPLE_CERTIFICATE_B64` (base64 `.p12` containing the Developer ID Application certificate and private key), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_API_KEY_P8` (contents of the App Store Connect `.p8` key), `APPLE_API_KEY`, `APPLE_API_ISSUER`, `TAURI_SIGNING_PRIVATE_KEY`, and `BETA_UPDATER_PUBLIC_KEY`. Set `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` only if the updater key has a password. Export the certificate from Keychain Access to a protected `.p12`, then add its base64 contents directly as an environment secret; never commit the export or paste it into an issue or chat.
- `beta-publication`: restrict deployments to `main` and store only `FEED_UPLOAD_TOKEN`. It has no required reviewer. When `publish: true` is selected, publication follows the successful signed build without a separate GitHub approval.

After bumping the version in `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and `src-tauri/Cargo.lock`, commit it to `main`. Review the source revision, release record, and remaining gates before running **Build and publish Agent Time beta** with `expected_version`, release notes, and `publish: true`. Publication then uploads immutable versioned files, verifies hosted archive and signature bytes, promotes the update manifest, and selects the DMG. The installed app will offer the higher signed version on its next check. Choose `publish: false` for a build-only rehearsal and inspect that artifact before a separate publication run; the later run builds a new artifact.

The runner's temporary Keychain and API key file are removed after the build. GitHub environment protection limits which branch can access release secrets; review workflow changes and the source commit before dispatching a publishing run. A failed or partial upload leaves the version for operator review; the workflow never overwrites an existing immutable artifact.

## Build and stage

1. Quit any beta app currently running from this worktree. Run `npm ci`, `npm test`, `npm run build`, `npm run sidecars:build`, and `cargo test --locked --manifest-path src-tauri/Cargo.toml`.
2. With protected inputs in the release environment, run `npm run beta:build`. The script rejects missing Developer ID credentials, non-HTTPS feed URLs, non-Apple-Silicon hosts, and unsigned or unstapled outputs. It requests Tauri's signed `.app`, `.dmg`, updater archive and `.sig`, skips Finder automation while packaging the DMG, then separately notarizes and staples the DMG and checks local signatures and Gatekeeper. Record the exact code revision, output hashes and notarization result.
3. Stage the generated `.app.tar.gz`, `.sig`, and release notes with `node scripts/publish-beta.mjs ARCHIVE SIGNATURE HTTPS_ARCHIVE_URL OUTPUT_DIR NOTES_FILE`. It creates an immutable version directory and `latest.json.candidate`; it does **not** replace the live `latest.json`.
4. Upload the immutable versioned archive and signature to the approved HTTPS host. From an external network, verify the archive URL returns the exact staged bytes and that the manifest's signature is the `.sig` content. Upload the notarized first-install DMG separately. An upload does not publish it; select its version through the authenticated `/admin/installers/current` endpoint only after validating the hosted bytes and the release record.
5. On a clean Apple Silicon Mac, install the first build through a quarantined Finder download. Verify startup, nested helpers, macOS permission choices, real agent hook events, and outdated-hook notification. Then test a later signed version through the app, including retained history, login item, Keychain/Accessibility continuity, and resumed capture. Test invalid signature, wrong architecture, stale manifest, offline feed, and interrupted download before promotion.
6. Only after the release owner accepts every gate, promote `latest.json.candidate` to `latest.json` atomically on the approved host. Record who approved it and when. A bad release is halted by removing the promoted manifest or serving the previous approved version; never overwrite an immutable archive or silently downgrade a database.

The updater's private key and Developer ID identity are separate: both must be valid. A successful local build, CI run, or unquarantined launch is not proof that the external beta is ready.
