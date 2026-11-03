// Turns transport and runtime failures into short, readable sentences for the UI.

/** Bridge errors that clear on their own; polls retry silently instead of showing them. */
const retryable = [/collector restarting/i, /collector is busy with a storage operation/i];

export function isRetryableError(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause ?? '');
  return retryable.some((pattern) => pattern.test(message));
}

const known: Array<[RegExp, string]> = [
  [
    /collector is busy with a storage operation/i,
    'Agent Time is busy with a storage operation. Try again in a few seconds.',
  ],
  [/timed? ?out|timeout/i, 'Agent Time took too long to answer. It will try again shortly.'],
  [
    /collector (is )?restarting|restarting collector/i,
    'The capture service is restarting. Try again in a few seconds.',
  ],
  [
    /local collector unavailable|failed to fetch|networkerror|load failed|connection refused|ECONNREFUSED/i,
    'Agent Time’s capture service is not reachable. Start the app or the development server.',
  ],
  [/invalid summary date|invalid review date/i, 'That date could not be loaded. Choose another day.'],
  [/requires the desktop app/i, 'This is only available in the Mac app.'],
];

/** Readable message for any thrown value. */
export function humanizeError(cause: unknown): string {
  let message =
    cause instanceof Error
      ? cause.message
      : typeof cause === 'string'
        ? cause
        : cause && typeof cause === 'object' && 'message' in cause
          ? String((cause as { message: unknown }).message)
          : String(cause ?? '');
  message = message.replace(/^(?:Uncaught\s+)?(?:[A-Za-z]*Error|Exception):\s*/u, '').trim();
  for (const [pattern, readable] of known) if (pattern.test(message)) return readable;
  if (!message) return 'Something went wrong. Try again.';
  message = message.charAt(0).toUpperCase() + message.slice(1);
  return /[.!?]$/.test(message) ? message : `${message}.`;
}
