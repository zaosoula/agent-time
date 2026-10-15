# Closed beta release incident runbook

Release owner and feedback address must be recorded outside Git and tested before invitations.

1. Record the affected version, first report time, tester count, and whether data integrity or capture is at risk. Acknowledge privately without requesting raw work content.
2. Halt promotion of the beta manifest. Keep immutable signed archives for investigation; do not overwrite a versioned artifact or replace its signature in place.
3. Contact every invited tester using the private invitation list. State whether to pause capture or keep the installed version offline. Do not recommend an untested downgrade.
4. Reproduce on a disposable copy of data, make a fixed forward version, and repeat signing, notarization, quarantine, update, and continuity gates before promoting it.
5. Update the release record with impact, recovery instructions, tests, and owner approval. If the updater cannot run, coordinate an individual recovery path and preserve the database first.
