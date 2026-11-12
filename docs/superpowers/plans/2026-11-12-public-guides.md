# Agent Time landing and public guides

User request: improve the existing landing to document the app, capture, MCP and the complete workflow.

- [x] Keep the existing English brand, local assets and download flow; update stale claims and add a visible documentation entry.
- [x] Add eight useful guides under /docs with shared navigation: getting started, capture, time calculations, review, billing, MCP, privacy/storage, troubleshooting. Ground examples and limits in current code; use no private captured screenshots or client information.
- [x] Serve only allowlisted static guide routes, retain restrictive script-free CSP and existing authenticated release/update routes, package assets in the current Docker image, provide sitemap and useful documentation 404.
- [x] Review factual coverage, test route/download/security/escaping contracts, check desktop and mobile navigation/reading in browser.
- [ ] Merge/push and deploy only the resolved Agent Time beta-feed application on Coolify cloud (oyxjlokh5habilxdaklybvv0, main), preserving its persistent release data and credentials. Verify deployment/public pages and the unchanged signed installer/feed.

Decisions: reuse the existing Node feed host without adding a new framework, service, analytics or client-side JS. Home stays concise; detailed documentation is readable HTML with normal links and native disclosure elements. Existing unrelated root files remain untouched. This is a website deployment, not an app binary release.

Verification: factual claims checked against current app/settings/MCP/billing/storage code; snapshot wording corrected. Route/auth/CSP/download/escaping checks passed. Browser desktop and 320px mobile checks passed; a 15px home overflow was fixed and rechecked (page/client both305px with scrollbar). Current app icon replaces the old website icon. Resolved production storage remains the existing /data persistent volume.
