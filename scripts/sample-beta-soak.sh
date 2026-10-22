#!/bin/bash
set -u

if [[ $# -ne 5 || ! $4 =~ ^[1-9][0-9]*$ || ! $5 =~ ^[1-9][0-9]*$ ]]; then
  printf 'Usage: %s APP_PATH SUPPORT_DIR OUTPUT_TSV SAMPLES INTERVAL_SECONDS\n' "$0" >&2
  exit 2
fi

app=$1
support=$2
output=$3
samples=$4
interval=$5
db="$support/events.sqlite"
runtime="$support/hook-runtime"
if [[ ! -f $db ]]; then printf 'Missing Agent Time database: %s\n' "$db" >&2; exit 1; fi
umask 077
if [[ ! -e $output ]]; then
  printf 'utc\tversion\tpid\trss_kb\tcpu_pct\tevents\tlatest_event_utc\tdb_bytes\truntime_kb\tquick_check\n' > "$output"
fi

for ((n=0;n<samples;n++)); do
  utc=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist" 2>/dev/null || printf 'missing')
  pid='-'; rss='-'; cpu='-'
  for candidate in $(pgrep -x agent-time 2>/dev/null || true); do
    command=$(ps -p "$candidate" -o command= 2>/dev/null || true)
    if [[ $command == "$app/Contents/MacOS/agent-time"* ]]; then
      pid=$candidate
      read -r rss cpu < <(ps -p "$candidate" -o rss=,%cpu= 2>/dev/null)
      break
    fi
  done
  IFS='|' read -r events latest < <(sqlite3 -readonly "$db" "select count(*),coalesce(datetime(max(observed_at),'unixepoch'),'none') from events" 2>/dev/null || printf 'error|none\n')
  db_bytes=$(stat -f '%z' "$db" 2>/dev/null || printf '0')
  runtime_kb=$(du -sk "$runtime" 2>/dev/null | awk '{print $1}')
  runtime_kb=${runtime_kb:-0}
  integrity='-'
  if ((n % 12 == 0)); then integrity=$(sqlite3 -readonly "$db" 'pragma quick_check(1)' 2>/dev/null || printf 'error'); fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$utc" "$version" "$pid" "$rss" "$cpu" "$events" "$latest" "$db_bytes" "$runtime_kb" "$integrity" >> "$output"
  if ((n+1<samples)); then sleep "$interval"; fi
done
