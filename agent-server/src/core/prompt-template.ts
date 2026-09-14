/** System variables are resolved at render time, never at config load time: a template that names
 *  `{{currentDateTime}}` must read the clock when the prompt is sent, not when the file was read. */
export function promptSystemVars(): Record<string, string> {
  const now = new Date();
  return {
    currentDateTime: now.toLocaleString('en-US', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }),
  };
}

/** Replace {{systemVar}} placeholders with system variable values. Unknown vars are left as-is —
 *  this runs over free-form author text (directives, system prompts) where a `{{...}}` the author
 *  wrote deliberately must survive. */
export function resolveSystemVars(text: string): string {
  const vars = promptSystemVars();
  return text.replace(/\{\{(\w+)\}\}/g, (match, key) => key in vars ? vars[key] : match);
}

/**
 * Render a prompt template: `{{#if var}}...{{/if}}` blocks first (kept only when the variable is
 * truthy), then `{{var}}` substitution. Unlike {@link resolveSystemVars}, an unknown `{{var}}`
 * renders as the empty string — a prompt template is a closed form whose whole variable set is
 * supplied by the caller, so a name that is not in it is a blank, not literal text to pass along.
 */
export function renderPromptTemplate(template: string, vars: Record<string, string>): string {
  const withBlocks = template.replace(
    /\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_, varName, content) => vars[varName] ? content : '',
  );
  return withBlocks.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] || '');
}
