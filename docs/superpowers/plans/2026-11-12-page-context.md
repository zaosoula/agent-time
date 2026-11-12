# Retain page context while navigating

Request: navigating around the app must preserve page context and let pending searches/reports finish.

- [x] Cache at most the eight top-level page instances, lazily created on first visit, with stable keys. Keep Home and Sessions' internal views separate. Keep drafts, local filters, expanded groups and asynchronous results in their existing owners.
- [x] Preserve the app-wide date/project/search/session context on ordinary navigation. Explicit project/date changes still update or reset the dependent selection as before. Open storage by selecting its existing tab instead of remounting Settings.
- [x] Save/restore scroll positions, including nested and horizontal panes, around page transitions. Ignore detached/replaced result nodes and stale navigation callbacks.
- [x] Let active jobs resolve while their pages are cached; avoid re-fetching unchanged weekly/work evidence on return. Keep passive refreshes and review keyboard actions limited to their visible page.
- [x] Verify actual page-boundary retention of a deferred job and unsaved edit through all eight destinations, scroll restoration, navigation, production build and browser behavior.

Retention lasts for the current app session. There are no persistent data snapshots, caches per query/date, or database changes. App-wide date/project filters intentionally remain shared; navigation alone no longer resets them.


Verification:40 focused UI tests passed, including compiling the actual app page boundary and switching through all eight pages with a pending promise; actual Teleport cleanup/restoration; and real weekly/work-evidence setup code retrying a result discarded while hidden. Production build/typecheck passed. Independent review found no remaining blockers after adding overlay presentation gates and committed-context tracking.

Browser proof used only synthetic data: started one billing report, left for Home, returned to its completed result with the unsaved project name and Billing tab retained; the fixture recorded exactly one billing-list request and one report request. Home search and zoom survived, and its scroll position restored exactly (608.5 px). A draft note dialog released its portal/focus trap when Cmd+, navigated to Settings, then reopened with the same note on return to Review. No live capture or database changes were made.
