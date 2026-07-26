/**
 * Check whether a timezone string is a valid IANA identifier
 * that Intl.DateTimeFormat can use.
 */
export function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Return the given timezone if valid IANA, otherwise fall back to UTC.
 */
export function resolveTimezone(tz: string): string {
  return isValidTimezone(tz) ? tz : 'UTC';
}

/**
 * Normalize a timestamp that is contractually a UTC instant into an explicit
 * UTC ISO string. Some writers (e.g. SQLite `datetime('now')`) emit a
 * space-separated, offset-less form like `2026-06-22 23:40:14`. `new Date()`
 * parses that as *local* time, shifting the displayed value by the zone offset
 * — which made scheduled-task headers read ~N hours ahead of reality. If the
 * input already carries a `Z` or `±HH:MM` offset it's returned unchanged.
 */
function ensureUtcIso(s: string): string {
  const t = s.trim();
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(t)) return t;
  return t.replace(' ', 'T') + 'Z';
}

/**
 * Convert a UTC ISO timestamp to a localized display string.
 * Uses the Intl API (no external dependencies).
 * Falls back to UTC if the timezone is invalid.
 */
export function formatLocalTime(utcIso: string, timezone: string): string {
  const date = new Date(ensureUtcIso(utcIso));
  return date.toLocaleString('en-US', {
    timeZone: resolveTimezone(timezone),
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}
