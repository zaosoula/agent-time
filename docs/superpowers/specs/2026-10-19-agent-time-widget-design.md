# Agent Time desktop widget design

Agent Time will offer one native macOS medium widget for an at-a-glance view of the current day. It shows estimated Mac activity, credited agent time, and agents working now, using the same summary semantics as My day. Clicking the widget opens Agent Time. The widget starts no collector and makes no network requests.

The running app publishes a small local snapshot through a macOS app group. The widget reads it and shows the snapshot's update time. When the snapshot is missing, from a previous calendar day, or too old, the widget says to open Agent Time instead of presenting old counts as current. A collector failure shows capture as unavailable. The snapshot carries the collector's local date so a late write cannot turn yesterday's totals into today's. macOS controls widget refresh timing; values are snapshots, not a live clock.

The extension is included in the Apple Silicon signed, notarized DMG and OTA archive. The minimum supported macOS version remains 13.5. The existing collector, hook, data store, and beta release behavior must remain intact. The existing unrelated worktree changes remain untouched.
