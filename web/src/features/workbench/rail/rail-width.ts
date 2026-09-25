// input:  localStorage
// output: RAIL_WIDTH_DEFAULT, clampRailWidth, loadRailWidth, saveRailWidth
// pos:    Persisted, drag-adjustable width of the desktop left rail
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

/** localStorage key — `cortex.*` UI-pref convention, alongside the rail's other stored state. */
export const RAIL_WIDTH_KEY = 'cortex.railWidth';

/** Default width, and the band a drag may move it in. The floor still fits a session title with its
 *  age and badges; past the ceiling the rail takes width the transcript needs more. */
export const RAIL_WIDTH_DEFAULT = 300;
export const RAIL_WIDTH_MIN = 220;
export const RAIL_WIDTH_MAX = 480;

/** Keep a width inside the band, in whole pixels; non-finite input falls back to the default. */
export function clampRailWidth(v: number): number {
  if (!Number.isFinite(v)) return RAIL_WIDTH_DEFAULT;
  return Math.round(Math.min(RAIL_WIDTH_MAX, Math.max(RAIL_WIDTH_MIN, v)));
}

/** Stored width → a usable width (default on missing / unparseable, clamped otherwise). */
export function parseRailWidth(raw: string | null): number {
  if (raw === null || raw.trim() === '') return RAIL_WIDTH_DEFAULT;
  return clampRailWidth(Number(raw));
}

export function loadRailWidth(): number {
  try {
    return parseRailWidth(window.localStorage.getItem(RAIL_WIDTH_KEY));
  } catch {
    return RAIL_WIDTH_DEFAULT;
  }
}

export function saveRailWidth(width: number): void {
  try {
    window.localStorage.setItem(RAIL_WIDTH_KEY, String(clampRailWidth(width)));
  } catch {
    /* persistence is best-effort */
  }
}
