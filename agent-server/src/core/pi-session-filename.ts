// input:  PI filenames and backend session id
// output: parsed and selected PI transcript filenames
// pos:    Shared PI transcript filename selector
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

const SESSION_ID_RE = '[A-Za-z0-9-]+';
const TIMESTAMP_RE = '\\d{4}-\\d{2}-\\d{2}T\\d{2}(?:[-:]\\d{2}){2}(?:-\\d{3})?Z';
const BACKUP_RE = /^(?<primary>.+)\.turn-(?<turn>\d+)\.bak$/;
const CANONICAL_RE = new RegExp(`^(?<sessionId>${SESSION_ID_RE})\\.jsonl$`);
const PREFIXED_RE = new RegExp(`^(?<timestamp>${TIMESTAMP_RE})_(?<sessionId>${SESSION_ID_RE})\\.jsonl$`);

export interface ParsedPISessionFilename {
  sessionId: string;
  primaryFilename: string;
  timestampPrefix: string | null;
  backupTurn: number | null;
}

/** Parse PI's canonical/timestamp-prefixed transcript names and their exact `.turn-N.bak` backups. */
export function parsePISessionFilename(filename: string): ParsedPISessionFilename | null {
  const backup = filename.match(BACKUP_RE);
  if (backup?.groups) {
    const turn = Number(backup.groups.turn);
    const primary = parsePISessionFilename(backup.groups.primary);
    if (!primary || !Number.isSafeInteger(turn) || turn < 0 || primary.backupTurn !== null) return null;
    return { ...primary, backupTurn: turn };
  }

  const prefixed = filename.match(PREFIXED_RE);
  if (prefixed?.groups?.sessionId && prefixed.groups.timestamp) {
    return {
      sessionId: prefixed.groups.sessionId,
      primaryFilename: filename,
      timestampPrefix: prefixed.groups.timestamp,
      backupTurn: null,
    };
  }

  const canonical = filename.match(CANONICAL_RE);
  if (canonical?.groups?.sessionId) {
    return {
      sessionId: canonical.groups.sessionId,
      primaryFilename: filename,
      timestampPrefix: null,
      backupTurn: null,
    };
  }

  return null;
}

/** Prefer PI's canonical id filename, then the newest exact timestamp-prefixed form. */
export function selectPISessionFilename(filenames: string[], sessionId: string): string | null {
  let newestPrefixed: string | null = null;
  for (const filename of filenames) {
    const parsed = parsePISessionFilename(filename);
    if (!parsed || parsed.backupTurn !== null || parsed.sessionId !== sessionId) continue;
    if (parsed.timestampPrefix === null) return filename;
    if (newestPrefixed === null || parsed.primaryFilename > newestPrefixed) newestPrefixed = parsed.primaryFilename;
  }
  return newestPrefixed;
}
