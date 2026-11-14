// A quote travels inside the message text as a leading Markdown blockquote: the agent reads it as
// written, and every surface that shows raw message text still shows something sensible.

/** `text` with `quote` set above it as a blockquote; a blank quote leaves the text as it is. */
export function quoteMessage(quote: string, text: string): string {
  const trimmed = quote.trim();
  if (!trimmed) return text;
  const block = trimmed.split('\n').map((line) => (line.trim() ? `> ${line}` : '>')).join('\n');
  return text ? `${block}\n\n${text}` : block;
}

/** The blockquote a message opens with, and what follows it. Only a quote on the first line counts. */
export function splitQuote(text: string): { quote: string | null; body: string } {
  const lines = text.split('\n');
  let n = 0;
  while (n < lines.length && lines[n].startsWith('>')) n++;
  const quote = lines.slice(0, n).map((line) => line.replace(/^> ?/, '')).join('\n').trim();
  if (!quote) return { quote: null, body: text };
  return { quote, body: lines.slice(n).join('\n').replace(/^(\s*\n)+/, '') };
}

/** A quote as one run of plain text, for the clamped previews: line breaks would spend their
 *  lines, and bold / code markers would show as raw punctuation. */
export function quotePreview(quote: string): string {
  return quote.replace(/\*\*|`/g, '').replace(/\s+/g, ' ').trim();
}
