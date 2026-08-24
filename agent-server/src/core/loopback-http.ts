// input:  node:http, JSON payloads, MCP timeout contract
// output: Explicitly bounded loopback JSON requests
// pos:    Connects MCP sidecars to the daemon webhook
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as http from 'node:http';
import type { OutgoingHttpHeaders, RequestOptions } from 'node:http';
import { MCP_INFRASTRUCTURE_TIMEOUT_MS } from './mcp-timeout.js';

export interface LoopbackJsonResponse {
  status: number;
  body: any;
}

export function requestLoopbackJson(
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
  headers: OutgoingHttpHeaders = {},
  timeoutMs = MCP_INFRASTRUCTURE_TIMEOUT_MS,
): Promise<LoopbackJsonResponse> {
  const payload = body === undefined ? null : JSON.stringify(body);
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request(requestOptions(method, parsed, payload, headers, timeoutMs), (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: parseJsonBody(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`Loopback request timed out after ${timeoutMs}ms`)));
    if (payload !== null) req.write(payload);
    req.end();
  });
}

function requestOptions(
  method: string,
  url: URL,
  payload: string | null,
  headers: OutgoingHttpHeaders,
  timeout: number,
): RequestOptions {
  return {
    hostname: url.hostname,
    port: url.port,
    path: `${url.pathname}${url.search}`,
    method,
    headers: payload === null
      ? headers
      : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers },
    timeout,
  };
}

function parseJsonBody(text: string): any {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}
