# Memory audit: beta.13 candidate

The signed beta.13 candidate was built from `99a38fab5e5f3376b5a0a1b612589247f91d6c95`. These measurements used its downloaded, notarized updater archive. The desktop window was not running on this Mac; only the existing widget process was live. No live tracking data was changed.

## Measurements

| Scenario | Evidence | Peak RSS | Other observation |
| --- | --- | ---: | --- |
| Collector `status`, private copy of 976,524-event database | Bundled Node, isolated protocol process | 121 MiB | 0.76 s process lifetime |
| Collector summary, empty output directory | Bundled Node, isolated protocol process | 117 MiB | 3.46 s process lifetime |
| Collector summary for an empty selected day, 976,524-event database | Bundled Node at low CPU priority, private copy | 1,533 MiB | 9.04 s; peak memory footprint 1,563 MiB |
| Same collector after the summary reply | `ps` while protocol process remained open | 1,344 MiB | Still 1,344 MiB ten seconds later at 0% CPU |
| MCP `current_work`, private copy of database | Bundled Node, isolated stdio request | 128 MiB | 0.20 s process lifetime |
| Hook runtime self-test | Bundled Node, isolated process | 95 MiB | 0.21 s process lifetime; this is not a real hook-delivery benchmark |
| Installed widget extension | `ps` of the live beta.11 widget | 17 MiB | Desktop app and collector were closed |

The copied SQLite database was 730 MiB. A summary request for a day with no activity returned 15.8 MiB of JSON. The response contains historical sessions and issues even though its intervals are clipped to the selected day. These are single-run measurements on a 32 GiB Apple Silicon Mac, not a distribution across devices. Peak RSS is process resident memory, while macOS memory footprint is the better estimate of physical memory charged to the process; both were high for the full replay.

## Causes visible in code

1. `EventStore.events()` parses every stored event into a JavaScript array. `Collector.summary()` passes the full array through `summarize()`, which builds deduplication maps, sorted arrays, sessions, and intervals. The collector retains the full summary in `summaryCache`. The weak event reference can be collected, but it does not bound the summary cache.
2. `summaryForDate()` invokes that full-history summary before clipping intervals. It leaves historical `sessions`, `coverage`, and `unresolved` in the day response. This explains the large reply for an empty day.
3. The desktop refreshes its day summary every five seconds, and the tray refreshes every five seconds. The collector permits a 15-second stale cache window for these calls; new hook or Orca events can force another full replay after it expires. A sustained replay frequency and CPU cost have not been measured with the desktop running, so this is a code-path risk rather than a measured cadence.
4. Each MCP client starts its own Node process. The server's bounded query path can load up to 250,000 SQLite rows at once. The measured `current_work` call is small, but large date queries need separate profiling. Short-lived hook processes have a separate startup cost.

## Next verification and repair order

1. Measure the desktop app, WebKit content process, collector, widget, and active MCP processes during normal work without taking focus. Record idle, active capture, day navigation, and a 30-minute steady period. The desktop was closed during this audit, so total app RAM remains unknown.
2. Design a bounded daily projection or validated checkpoint so routine day and tray requests do not replay all history. Verify exact totals and attribution against full replay for cross-midnight sessions, out-of-order events, daylight saving transitions, hook repairs, and review decisions. A simple time cutoff could silently lose valid intervals.
3. Return a day-bounded IPC payload and provide capture-health history through a separate bounded query. Confirm the UI still shows relevant session and coverage evidence. This reduces WebKit transfer and renderer memory but does not by itself fix collector replay memory.
4. Profile a large MCP date query and real hook delivery. Set a memory and CPU budget from measurements before choosing a shared runtime, streaming query, or smaller helper.

Beta.13 does not include a memory fix. The release owner requested publication before this audit; the protected publication job was waiting for environment review when these measurements were taken.
