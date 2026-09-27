// The native shell (Rust / Kotlin) does not know the UI language, so the errors it returns for the
// UI are `code` or `code: detail` — a stable snake_case code plus optional technical detail (an OS
// error, a path, process output). The webview words the code in its own language and shows the
// detail after it, as secondary information. Unknown codes and free-form messages pass through raw.

export interface NativeErrorParts { code: string; detail: string | null }

export function nativeErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  return error instanceof Error ? error.message : String(error);
}

export function parseNativeError(raw: string): NativeErrorParts | null {
  const match = /^([A-Za-z][A-Za-z0-9_]*)(?::\s*([\s\S]*))?$/.exec(raw.trim());
  if (!match) return null;
  return { code: match[1]!, detail: match[2]?.trim() || null };
}

/** `copy[code]` for a known code, with any detail appended in parentheses; the raw text otherwise. */
export function nativeErrorText(error: unknown, copy: Readonly<Record<string, string | undefined>>): string {
  const raw = nativeErrorMessage(error);
  const parts = parseNativeError(raw);
  const text = parts && Object.hasOwn(copy, parts.code) ? copy[parts.code] : undefined;
  if (!parts || !text) return raw;
  return parts.detail ? `${text} (${parts.detail})` : text;
}
