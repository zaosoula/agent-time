# Public beta download and update feed

This service hosts the signed Apple Silicon updater archive, the first-install DMG, and the public beta landing page at `/`. Deploy this directory as a Dockerfile application with a persistent volume at `/data` and a public HTTPS origin.

Runtime variables:

- `UPLOAD_TOKEN`: a random secret of at least 32 characters, stored outside Git.
- `PUBLIC_ORIGIN`: `https://agent-time.ezyostudio.com`.
- `DATA_DIR`: `/data` (default).
- `PORT`: `3000` (default).

`GET /healthz` checks the service. `GET /beta/latest.json` returns 404 until promotion. Public versioned archive URLs are immutable. The service does not expose the candidate manifest or the secrets.

Upload the `.app.tar.gz` and its `.sig` to `PUT /admin/releases/<version>/<encoded filename>` with `Authorization: Bearer <token>` and `X-Content-SHA256: <hex digest>`. A mismatched digest is rejected; an existing versioned file returns 409. Upload the staged manifest to `PUT /admin/manifest/candidate` with the same headers. The service checks that its one Apple Silicon URL points to the uploaded archive and that its signature matches the uploaded `.sig`.

Upload the notarized DMG to `PUT /admin/installers/<version>/<encoded filename>` with the same authorization and digest headers. An uploaded DMG stays unpublished until `PUT /admin/installers/current` receives its version as the body, again with authorization and `X-Content-SHA256`. The service confirms that the DMG exists, then atomically selects that version for the landing page and public versioned download URL. Older installers return 404. Select a new installer only after validating its hosted bytes and release record.

To select an uploaded installer without putting the token in process arguments, set `UPLOAD_TOKEN_FILE` to the protected local token path and run `node beta-feed/select-installer.mjs VERSION`. Run `node beta-feed/select-installer.mjs withdraw` to remove the public download immediately. The script uses `https://agent-time-origin.ezyostudio.com` for authenticated requests unless `UPLOAD_ORIGIN` is set. Stage the updater archive and signature before the candidate manifest. Verify hosted file hashes before promotion.

After update gates are accepted in the release record, `POST /admin/manifest/promote` makes the candidate live. `POST /admin/manifest/withdraw` removes the live manifest if a release must stop. Both require the bearer token. Keep the prior installed version usable; publish a higher signed version to recover from a bad update.
