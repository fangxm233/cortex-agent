// input:  untrusted postMessage payloads from preview frames
// output: normalized page titles with validated HTTP(S) origins
// pos:    Browser title-bridge protocol parser
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

export const FRAME_TITLE_TAG = '__cortexBrowserTitle:v1';
const TITLE_MAX = 160;

export type FrameTitlePhase = 'load' | 'restore' | 'update';

export interface FrameTitleMessage {
  title: string | null;
  href: string;
  timeOrigin: number;
  phase: FrameTitlePhase;
}

export function parseFrameTitleMessage(data: unknown, origin: string): FrameTitleMessage | null {
  if (typeof data !== 'object' || data === null) return null;
  const message = data as Record<string, unknown>;
  if (message.type !== FRAME_TITLE_TAG || typeof message.title !== 'string'
    || typeof message.href !== 'string' || typeof message.timeOrigin !== 'number'
    || !Number.isFinite(message.timeOrigin) || message.timeOrigin < 0
    || !['load', 'restore', 'update'].includes(String(message.phase))) return null;
  let url: URL;
  try {
    url = new URL(message.href);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) return null;
  const normalized = message.title.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);
  return {
    title: normalized === '' ? null : normalized,
    href: url.toString(),
    timeOrigin: message.timeOrigin,
    phase: message.phase as FrameTitlePhase,
  };
}

export function matchFrameTitleMessage(
  frames: ReadonlyMap<string, { contentWindow: unknown }>,
  source: unknown,
  data: unknown,
  origin: string,
): { tabId: string; title: string | null; timeOrigin: number; phase: FrameTitlePhase } | null {
  const frame = [...frames].find(([, candidate]) => candidate.contentWindow === source);
  if (!frame) return null;
  const message = parseFrameTitleMessage(data, origin);
  return message ? {
    tabId: frame[0],
    title: message.title,
    timeOrigin: message.timeOrigin,
    phase: message.phase,
  } : null;
}
