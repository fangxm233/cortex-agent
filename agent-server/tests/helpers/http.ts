// In-memory stand-ins for the node:http request/response pair a route handler receives, for tests
// that call a handler directly instead of standing up a server.
import { Readable } from 'node:stream';
import type * as http from 'node:http';

export interface FakeRes {
  statusCode: number;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  headersSent: boolean;
  writableEnded: boolean;
  writeHead(status: number, headers?: Record<string, string | number>): FakeRes;
  setHeader(name: string, value: string | number): void;
  write(chunk: Buffer | string): boolean;
  end(chunk?: Buffer | string): void;
  readonly body: Buffer;
  readonly text: string;
  json(): any;
}

export function fakeRes(): FakeRes {
  const chunks: Buffer[] = [];
  const toBuffer = (chunk: Buffer | string) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return {
    statusCode: 0,
    headers: {},
    headersSent: false,
    writableEnded: false,
    writeHead(status, headers) {
      this.statusCode = status;
      if (headers) for (const [k, v] of Object.entries(headers)) this.headers[k.toLowerCase()] = String(v);
      this.headersSent = true;
      return this;
    },
    setHeader(name, value) { this.headers[name.toLowerCase()] = String(value); },
    write(chunk) { chunks.push(toBuffer(chunk)); return true; },
    end(chunk) {
      if (chunk) chunks.push(toBuffer(chunk));
      this.writableEnded = true;
    },
    get body() { return Buffer.concat(chunks); },
    get text() { return this.body.toString('utf8'); },
    json() { return JSON.parse(this.text); },
  };
}

/** A request whose body (JSON-encoded unless already a string) can be read as a stream. */
export function fakeReq(
  method: string, url: string, body?: unknown, headers: Record<string, string> = {},
): http.IncomingMessage {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(raw)]);
  return Object.assign(stream, { method, url, headers }) as unknown as http.IncomingMessage;
}

/** Hand a FakeRes to a handler typed for the real response. */
export const asServerResponse = (res: FakeRes) => res as unknown as http.ServerResponse;
