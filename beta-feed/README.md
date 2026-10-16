# Closed beta update feed

This service hosts the signed Apple Silicon updater archive. The installer DMG stays in private release storage. Deploy this directory as a Dockerfile application with a persistent volume at `/data` and a public HTTPS origin.

Runtime variables:

- `UPLOAD_TOKEN`: a random secret of at least 32 characters, stored outside Git.
- `PUBLIC_ORIGIN`: `https://agent-time.ezyostudio.com`.
- `DATA_DIR`: `/data` (default).
- `PORT`: `3000` (default).

`GET /healthz` checks the service. `GET /beta/latest.json` returns 404 until promotion. Public versioned archive URLs are immutable. The service does not expose the candidate manifest or the upload token.

Upload the `.app.tar.gz` and its `.sig` to `PUT /admin/releases/<version>/<encoded filename>` with `Authorization: Bearer <token>` and `X-Content-SHA256: <hex digest>`. A mismatched digest is rejected; an existing versioned file returns 409. Upload the staged manifest to `PUT /admin/manifest/candidate` with the same headers. The service checks that its one Apple Silicon URL points to the uploaded archive and that its signature matches the uploaded `.sig`.

After download and update gates are accepted in the release record, `POST /admin/manifest/promote` makes the candidate live. `POST /admin/manifest/withdraw` removes the live manifest if a release must stop. Both require the bearer token. Keep the prior installed version usable; publish a higher signed version to recover from a bad update.
