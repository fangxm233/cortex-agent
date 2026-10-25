import { CLIENT_KINDS } from './schema.js';

export type ClientKind = (typeof CLIENT_KINDS)[number];

/** The `x-cortex-client` request header, or null when absent or unrecognized. */
export function parseClientKind(header: string | string[] | undefined): ClientKind | null {
  const raw = Array.isArray(header) ? header[0] : header;
  const value = raw?.trim().toLowerCase();
  return (CLIENT_KINDS as readonly string[]).includes(value ?? '') ? value as ClientKind : null;
}
