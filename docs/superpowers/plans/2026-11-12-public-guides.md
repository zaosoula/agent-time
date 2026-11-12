# Agent Time landing and public guides

User request: improve the existing landing to document the app, capture, MCP and the complete workflow.

- [x] Keep the existing English brand, local assets and download flow; update stale claims and add a visible documentation entry.
- [x] Add eight useful guides under /docs with shared navigation: getting started, capture, time calculations, review, billing, MCP, privacy/storage, troubleshooting. Ground examples and limits in current code; use no private captured screenshots or client information.
- [x] Serve only allowlisted static guide routes, retain restrictive script-free CSP and existing authenticated release/update routes, package assets in the current Docker image, provide sitemap and useful documentation 404.
- [x] Review factual coverage, test route/download/security/escaping contracts, check desktop and mobile navigation/reading in browser.
- [x] Merge/push and deploy only the resolved Agent Time beta-feed application on Coolify cloud (oyxjlokh5habilxdaklybvv0, main), preserving its persistent release data and application credentials. Verify deployment/public pages and the unchanged signed installer/feed.

Decisions: reuse the existing Node feed host without adding a new framework, service, analytics or client-side JS. Home stays concise; detailed documentation is readable HTML with normal links and native disclosure elements. Existing unrelated root files remain untouched. This is a website deployment, not an app binary release.

Verification: factual claims checked against current app/settings/MCP/billing/storage code; snapshot wording corrected. Route/auth/CSP/download/escaping checks passed. Browser desktop and 320px mobile checks passed; a 15px home overflow was fixed and rechecked (page/client both305px with scrollbar). Current app icon replaces the old website icon. Resolved production storage remains the existing /data persistent volume.

Publication: source f39c7b820b0d6c64bc381278af78a99470cc7efe deployed successfully through Coolify cloud deployment grz68edqpbdmyljlwhsntmex at 2026-11-12T03:56:47Z. Runtime running:healthy. Configured the application's required build-server image as ghcr.io/zaosoula/agent-time-beta-feed and refreshed the existing same-account GHCR login on the build server after the previous credential denied pushes. Server roles and the /data release volume were retained.

Live verification at 2026-11-12T03:57:50Z: home, hub and eight guides all HTTP 200; origin HTML matches committed renderers exactly, public headings match and restrictive CSP remains present. Cloudflare adds its existing edge scripts/email transformation on the primary domain. Health, sitemap and robots return 200, unknown guide returns 404/noindex, new icon hash matches source, beta.49 update manifest is unchanged, and its selected DMG download returns 200 with binary data. Seventeen focused tests pass. This publication changes the website only.
