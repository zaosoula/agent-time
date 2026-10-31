# Memory audit: beta.13 candidate

The signed beta.13 candidate was built from `99a38fab5e5f3376b5a0a1b612589247f91d6c95`. Isolated measurements used its downloaded, notarized updater archive. The release owner then authorized a background launch of the installed beta.11 desktop app for live process sampling. The app was closed again after sampling, restoring its previous state. No live tracking data was cleared or changed by the isolated tests.

## Measurements

| Scenario | Evidence | Peak RSS | Other observation |
| --- | --- | ---: | --- |
| Collector `status`, private copy of 976,524-event database | Bundled Node, isolated protocol process | 121 MiB | 0.76 s process lifetime |
| Collector summary, empty output directory | Bundled Node, isolated protocol process | 117 MiB | 3.46 s process lifetime |
| Collector summary for an empty selected day, 976,524-event database | Bundled Node at low CPU priority, private copy | 1,533 MiB | 9.04 s; peak memory footprint 1,563 MiB |
| Same collector after the summary reply | `ps` while protocol process remained open | 1,344 MiB | Still 1,344 MiB ten seconds later at 0% CPU |
| MCP `current_work`, private copy of database | Bundled Node, isolated stdio request | 128 MiB | 0.20 s process lifetime |
| Hook runtime self-test | Bundled Node, isolated process | 95 MiB | 0.21 s process lifetime; this is not a real hook-delivery benchmark |
| Installed widget extension before desktop launch | `ps` of the live beta.11 widget | 17 MiB | Desktop app and collector were closed |
| Installed beta.11 collector during desktop refresh | Eight `ps` samples over 36 seconds | 1,622 MiB | 1,145–1,622 MiB RSS; several samples showed 81–126% CPU |
| Installed beta.11 desktop host and WebKit content | Same live samples | 284 MiB + 63 MiB | Host settled around 274–284 MiB; WebKit around 51–63 MiB |
| Installed beta.11 widget and macOS helper while app ran | Same live samples | 26 MiB + 12 MiB | Their RSS was relatively stable |

The copied SQLite database was 730 MiB. A summary request for a day with no activity returned 15.8 MiB of JSON. The response contains historical sessions and issues even though its intervals are clipped to the selected day. These are measurements on one 32 GiB Apple Silicon Mac, not a distribution across devices. Peak RSS is process resident memory, while macOS memory footprint is the better estimate of physical memory charged to the process; both were high for the full replay. Live desktop figures are beta.11, while the isolated collector figures are beta.13; they should not be summed as a beta.13 whole-app measurement.

## Causes visible in code

1. `EventStore.events()` parses every stored event into a JavaScript array. `Collector.summary()` passes the full array through `summarize()`, which builds deduplication maps, sorted arrays, sessions, and intervals. The collector retains the full summary in `summaryCache`. The weak event reference can be collected, but it does not bound the summary cache.
2. `summaryForDate()` invokes that full-history summary before clipping intervals. It leaves historical `sessions`, `coverage`, and `unresolved` in the day response. This explains the large reply for an empty day.
3. The desktop refreshes its day summary every five seconds, and the tray refreshes every five seconds. The collector permits a 15-second stale cache window for these calls; new hook or Orca events can force another full replay after it expires. The short beta.11 live sample showed repeated near-core CPU use, but a 30-minute cadence and beta.13 live behavior have not been measured.
4. Each MCP client starts its own Node process. The server's bounded query path can load up to 250,000 SQLite rows at once. The measured `current_work` call is small, but large date queries need separate profiling. Short-lived hook processes have a separate startup cost.

## Next verification and repair order

1. Repeat the live measurement on installed beta.13 during normal work without taking focus. Record idle, active capture, day navigation, and a 30-minute steady period. The beta.11 sample covered only startup and 36 seconds of refreshes; no MCP client process was active.
2. Design a bounded daily projection or validated checkpoint so routine day and tray requests do not replay all history. Verify exact totals and attribution against full replay for cross-midnight sessions, out-of-order events, daylight saving transitions, hook repairs, and review decisions. A simple time cutoff could silently lose valid intervals.
3. Return a day-bounded IPC payload and provide capture-health history through a separate bounded query. Confirm the UI still shows relevant session and coverage evidence. This reduces WebKit transfer and renderer memory but does not by itself fix collector replay memory.
4. Profile a large MCP date query and real hook delivery. Set a memory and CPU budget from measurements before choosing a shared runtime, streaming query, or smaller helper.

Beta.13 does not include a memory fix. The release owner requested publication before this audit; the protected publication job was waiting for environment review when these measurements were taken.
