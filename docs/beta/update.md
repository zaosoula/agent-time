# Beta updates

Agent Time checks the beta feed on launch and about hourly while open. When an update is available, the app shows its version and release notes. Choose **Install and restart** when you can tolerate a short capture gap. It downloads the signed archive, closes the collector before installation, and relaunches. You do not need to download or replace the app manually after the first install.

An offline or interrupted download leaves the installed version running. Retry when the connection returns. If installation fails after capture has stopped, the app attempts to relaunch so capture can resume. Check Capture health after the restart for a new event. A provider update can require **Install / repair hooks**; Agent Time should show that state instead of silently claiming coverage.

If the app cannot update or reopen, contact `zao.soula@ezyostudio.com`. Support will coordinate recovery without deleting the local database. Do not install an older build over a newer database unless its rollback compatibility was tested and recorded in [release-record.md](release-record.md).
