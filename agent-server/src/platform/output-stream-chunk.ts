export const DEFAULT_MAX_CHUNK = 3000;
export const MAX_HORIZONTAL_RULES = 3;

export function countHorizontalRules(text: string): number {
  return text.split('\n').filter(line => /^-{3,}\s*$/.test(line.trim())).length;
}

export function countTables(text: string): number {
  const lines = text.split('\n');
  let count = 0;
  let inTable = false;
  for (const line of lines) {
    const isTableLine = /^\s*\|/.test(line);
    if (isTableLine && !inTable) { count++; inTable = true; }
    else if (!isTableLine) { inTable = false; }
  }
  return count;
}

export function needsSplit(text: string, maxChunk: number): boolean {
  return countTables(text) > 1
    || text.length > maxChunk
    || countHorizontalRules(text) >= MAX_HORIZONTAL_RULES;
}

export function chunkText(text: string, maxChunk: number): string[] {
  if (text.length <= maxChunk) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxChunk) {
    let splitAt = remaining.lastIndexOf('\n', maxChunk);
    if (splitAt <= 0) splitAt = maxChunk;
    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).replace(/^\n/, '');
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
