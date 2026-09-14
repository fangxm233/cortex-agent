// input:  a server status-message text (status-format.ts buildUserProcessingMessage / the
//          sealed "Done/Error" line)
// output: a compact one-line status for the dedicated line above the input box —
//          state + elapsed time + turns + cost only (session tag / profile stripped)
// pos:    Pure helper for the M5 Ink client. Status frames are identified upstream by their
//          `actions` rich-block; this parses their text into the bits the user wants shown.
//
// Source formats (src/core/status-format.ts + orchestration/turn/terminal.ts):
//   processing: "⏳ Processing | <name> · `<uuid>` | <profile> | ⏱️ <dur>[ | 🔁 <n> turns]"
//   done/error: "✅ Done | <name> · `<uuid>` | (<dur> · <n> turns · $<cost>)"
// Parsing is defensive: any missing field is simply omitted.

export interface TurnStatus {
  /** Leading "<icon> <word>" segment, e.g. "⏳ Processing" or "✅ Done". */
  state: string;
  time: string | null;
  turns: number | null;
  cost: string | null;
}

export function parseTurnStatus(text: string): TurnStatus {
  const trimmed = text.trim();
  // State = everything before the first " | " (icon + word), else up to the first "(".
  let state = trimmed;
  const barIdx = trimmed.indexOf(' | ');
  if (barIdx !== -1) {
    state = trimmed.slice(0, barIdx).trim();
  } else {
    const parenIdx = trimmed.indexOf('(');
    if (parenIdx > 0) state = trimmed.slice(0, parenIdx).trim();
  }

  // Time: prefer the stopwatch-prefixed duration (processing), else the "(<dur>" in the
  // sealed metrics group. Durations look like "4s", "1m2s", "1.5s", "1h3m".
  let time: string | null = null;
  const stopwatch = trimmed.match(/⏱️\s*([0-9][0-9smhd.]*)/);
  if (stopwatch) {
    time = stopwatch[1];
  } else {
    const paren = trimmed.match(/\(\s*([0-9][0-9smhd.]*)\b/);
    if (paren) time = paren[1];
  }

  const turnsM = trimmed.match(/([0-9]+)\s*turns?\b/);
  const turns = turnsM ? Number(turnsM[1]) : null;

  const costM = trimmed.match(/\$([0-9]+(?:\.[0-9]+)?)/);
  const cost = costM ? costM[1] : null;

  return { state, time, turns, cost };
}

/** Render a parsed status as a single compact line: "<state> · <time> · <n> turns · $<cost>". */
export function formatTurnStatus(s: TurnStatus): string {
  const parts: string[] = [s.state];
  if (s.time) parts.push(s.time);
  if (s.turns != null) parts.push(`${s.turns} turns`);
  if (s.cost != null) parts.push(`$${s.cost}`);
  return parts.join(' · ');
}
