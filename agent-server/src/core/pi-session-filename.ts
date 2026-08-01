// input:  PI filenames and backend session id
// output: deterministic transcript filename or null
// pos:    Shared PI transcript filename selector
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

/** Prefer PI's canonical id filename, then the newest timestamp-prefixed form. */
export function selectPISessionFilename(filenames: string[], sessionId: string): string | null {
  const canonical = `${sessionId}.jsonl`;
  if (filenames.includes(canonical)) return canonical;
  let newest: string | null = null;
  for (const filename of filenames) {
    if (!filename.endsWith(`_${sessionId}.jsonl`)) continue;
    if (newest === null || filename > newest) newest = filename;
  }
  return newest;
}
