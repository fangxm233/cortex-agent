// $CORTEX_HOME/.gitignore lives at the home root, so a pattern with a slash is anchored there:
// the shipped `projects/*/…/index.md` rules never matched the memory indexes under context/.
const MEMORY_INDEX_IGNORES = [
  'context/projects/*/experiments/index.md',
  'context/projects/*/knowledge/index.md',
  'context/projects/*/patterns/index.md',
];

/** Append whichever memory-index rules are absent; every existing line is kept as is. */
export function appendMemoryIndexIgnores(text: string): string {
  const present = new Set(text.split(/\r?\n/).map(line => line.trim()));
  const missing = MEMORY_INDEX_IGNORES.filter(rule => !present.has(rule));
  if (missing.length === 0) return text;
  const separator = text.length === 0 || text.endsWith('\n') ? '' : '\n';
  return `${text}${separator}${missing.join('\n')}\n`;
}
