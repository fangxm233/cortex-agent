/**
 * Copy `text` to the system clipboard. `navigator.clipboard` exists only in secure contexts
 * (HTTPS / localhost), so a page served over plain HTTP falls back to `execCommand('copy')` on a
 * hidden textarea. Must run inside the user gesture that asked for the copy.
 */
export async function copyText(text: string): Promise<boolean> {
  const clipboard = globalThis.navigator?.clipboard;
  if (clipboard) {
    try { await clipboard.writeText(text); return true; } catch { /* fall through */ }
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false;
  const active = document.activeElement as HTMLElement | null;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;';
  document.body.appendChild(area);
  area.select();
  area.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  area.remove();
  active?.focus?.({ preventScroll: true });
  return ok;
}
