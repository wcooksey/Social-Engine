/**
 * Lightweight timezone helpers so quiet-hours guardrails respect the LEAD's
 * local time, not the server's. We derive a coarse IANA zone from the US state
 * when the lead's timezone isn't known, then compute the lead's local hour
 * using Intl (no external tz database needed).
 */

// US state/territory → representative IANA zone. Coarse but correct for
// quiet-hours purposes (states spanning two zones pick the dominant one).
const STATE_TZ: Record<string, string> = {
  AL: 'America/Chicago', AK: 'America/Anchorage', AZ: 'America/Phoenix',
  AR: 'America/Chicago', CA: 'America/Los_Angeles', CO: 'America/Denver',
  CT: 'America/New_York', DE: 'America/New_York', FL: 'America/New_York',
  GA: 'America/New_York', HI: 'Pacific/Honolulu', ID: 'America/Boise',
  IL: 'America/Chicago', IN: 'America/Indiana/Indianapolis', IA: 'America/Chicago',
  KS: 'America/Chicago', KY: 'America/New_York', LA: 'America/Chicago',
  ME: 'America/New_York', MD: 'America/New_York', MA: 'America/New_York',
  MI: 'America/New_York', MN: 'America/Chicago', MS: 'America/Chicago',
  MO: 'America/Chicago', MT: 'America/Denver', NE: 'America/Chicago',
  NV: 'America/Los_Angeles', NH: 'America/New_York', NJ: 'America/New_York',
  NM: 'America/Denver', NY: 'America/New_York', NC: 'America/New_York',
  ND: 'America/Chicago', OH: 'America/New_York', OK: 'America/Chicago',
  OR: 'America/Los_Angeles', PA: 'America/New_York', RI: 'America/New_York',
  SC: 'America/New_York', SD: 'America/Chicago', TN: 'America/Chicago',
  TX: 'America/Chicago', UT: 'America/Denver', VT: 'America/New_York',
  VA: 'America/New_York', WA: 'America/Los_Angeles', WV: 'America/New_York',
  WI: 'America/Chicago', WY: 'America/Denver', DC: 'America/New_York',
  PR: 'America/Puerto_Rico',
};

const DEFAULT_TZ = 'America/New_York';

export function timezoneForState(state?: string | null): string | null {
  if (!state) return null;
  return STATE_TZ[state.trim().toUpperCase()] || null;
}

/** Best-effort IANA zone for a lead: explicit tz → state-derived → default. */
export function resolveLeadTimezone(lead: { timezone?: string | null; state?: string | null }): string {
  return lead.timezone || timezoneForState(lead.state) || DEFAULT_TZ;
}

/** The current local hour (0–23) in the given IANA timezone. */
export function localHourIn(timezone: string, at: Date = new Date()): number {
  try {
    const s = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    }).format(at);
    const h = parseInt(s, 10);
    return isNaN(h) ? at.getHours() : h % 24;
  } catch {
    return at.getHours();
  }
}

/** True when `at` falls inside [startHour, endHour) treating the window as
 *  overnight when start > end (e.g. 20:00–08:00). */
export function isWithinQuietHours(startHour: number, endHour: number, localHour: number): boolean {
  return startHour > endHour
    ? localHour >= startHour || localHour < endHour
    : localHour >= startHour && localHour < endHour;
}
