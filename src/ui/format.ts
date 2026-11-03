// Shared formatting for the dashboard. Every time, date and duration shown in the UI goes through
// these helpers so the app speaks one consistent, system-locale format.

const formatters = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(key: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(undefined, options);
    formatters.set(key, formatter);
  }
  return formatter;
}

const toDate = (seconds: number) => new Date(seconds * 1000);

/** Hours and minutes, e.g. "14:05" or "2:05 PM" depending on the system locale. */
export function clock(seconds: number): string {
  return dateFormatter('clock', { hour: 'numeric', minute: '2-digit' }).format(toDate(seconds));
}

/** Hours, minutes and seconds. */
export function preciseClock(seconds: number): string {
  return dateFormatter('precise', { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(
    toDate(seconds),
  );
}

/** Short date and time, e.g. "Nov 3, 14:05". */
export function dateTime(seconds: number): string {
  return dateFormatter('datetime', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(toDate(seconds));
}

/** Long day heading for a YYYY-MM-DD date, e.g. "Tuesday, November 3". */
export function longDate(date: string): string {
  return dateFormatter('long-date', { weekday: 'long', month: 'long', day: 'numeric' }).format(
    new Date(`${date}T12:00:00`),
  );
}

/** Compact day label for a YYYY-MM-DD date, e.g. "Tue, Nov 3". */
export function shortDate(date: string): string {
  return dateFormatter('short-date', { weekday: 'short', month: 'short', day: 'numeric' }).format(
    new Date(`${date}T12:00:00`),
  );
}

/**
 * One duration format everywhere: "45s", "12m", "1h 30m", "3h".
 * Minutes are rounded; anything under a minute shows seconds.
 */
export function duration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0m';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60),
    rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/** Relative age of a unix timestamp (seconds) compared with `now` (seconds). */
export function age(at: number | null | undefined, now = Date.now() / 1000): string {
  if (!at) return 'No event yet';
  const seconds = Math.max(0, Math.floor(now - at));
  if (seconds < 5) return 'Just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

const numberFormatters = new Map<string, Intl.NumberFormat>();
function numberFormatter(key: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  let formatter = numberFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(undefined, options);
    numberFormatters.set(key, formatter);
  }
  return formatter;
}

export const count = (value: number) => numberFormatter('count', {}).format(value);
export const compactNumber = (value: number) =>
  numberFormatter('compact', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
export const usd = (value: number) =>
  numberFormatter('usd', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value);

export function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024,
    unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${numberFormatter('bytes', { maximumFractionDigits: size < 10 ? 1 : 0 }).format(size)} ${units[unit]}`;
}

export const plural = (value: number, one: string, many = `${one}s`) =>
  `${count(value)} ${value === 1 ? one : many}`;

/** Local calendar date as YYYY-MM-DD. */
export function dateString(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** True for a real YYYY-MM-DD calendar date. */
export function isValidDateString(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00`);
  return !Number.isNaN(date.getTime()) && dateString(date) === value;
}

export function shiftDate(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00`);
  date.setDate(date.getDate() + days);
  return dateString(date);
}
