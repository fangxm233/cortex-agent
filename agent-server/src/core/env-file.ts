import { mutateFileAtomically } from './atomic-write.js';

/** Set one `KEY=value` line in dotenv text, replacing the last assignment of the key or
 *  appending one; returns the input unchanged when the line already reads that way. */
export function upsertEnvContents(existing: string, key: string, value: string): string {
  const line = `${key}=${value}`;
  const lines = existing === '' ? [] : existing.replace(/\n+$/, '').split('\n');
  const re = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
  const idx = lines.map(candidate => re.test(candidate)).lastIndexOf(true);
  if (idx >= 0) {
    if (lines[idx] === line) return existing;
    lines[idx] = line;
  } else {
    lines.push(line);
  }
  return lines.join('\n') + '\n';
}

/** Serialize dotenv read-modify-write across processes so unrelated settings survive. */
export function upsertEnvVar(file: string, key: string, value: string): Promise<void> {
  return mutateFileAtomically(
    file,
    existing => upsertEnvContents(existing, key, value),
    { mode: 0o600 },
  );
}
