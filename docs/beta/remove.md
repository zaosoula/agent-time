# Pause, disconnect, or remove Agent Time

- To pause without removing data, use **Pause capture** in the app or menu bar. Closing only the dashboard window leaves the menu bar collector running; choose **Quit Agent Time** to stop it.
- To stop future login launches, turn off **Start capture when I sign in** in Settings → System. macOS Login Items may also show Agent Time.
- Before deleting the app, use the tracking cleanup action in Settings to preview and remove only Agent Time's managed hooks and helper runtimes. Existing hooks from other tools are retained. Disconnect optional Linear access in Settings if connected.
- Then quit Agent Time and remove the app from Applications. The local database and settings remain in `~/Library/Application Support/studio.ezyo.agenttime/` so you can reinstall without losing history. If you choose permanent history deletion, first export anything you need, then remove that folder after quitting. This cannot be undone without your own backup.

Deleting the `.app` alone leaves user-wide agent hooks and local history behind. If cleanup reports an error, do not delete helper runtimes by hand; send the redacted summary to support so ownership can be checked.
