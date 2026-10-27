// Test-only pure helpers. Nothing is patched until the dedicated preload calls installGuards.
import assert from 'node:assert/strict';
import net from 'node:net';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';

export function remapGateway(url, source, port) {
  assert(Number.isInteger(port) && port >= 1024 && port <= 9999 && port !== 9880, 'Use a four-digit test gateway port');
  const unbundled = url.endsWith('/dist/domain/costs/gateway-manager.js');
  const marker = /["']gateway-mgr["']/.test(source);
  if (!unbundled && !marker) return null;
  assert(marker && (unbundled || url.includes('/dist/chunks/')), `Unfamiliar gateway layout: ${url}`);
  const patterns = [/(\b(?:const|let|var)\s+GATEWAY_PORT\s*=\s*)9880\b/g, /(=["']127\.0\.0\.1["'],\w+=)9880\b/g];
  const matches = patterns.flatMap(pattern => [...source.matchAll(pattern)]);
  assert.equal(matches.length, 1, `Unfamiliar/ambiguous gateway constant: ${url}`);
  const match = matches[0];
  const index = match.index + match[1].length;
  return source.slice(0, index) + String(port) + source.slice(index + 4);
}

export function guardedPort(args) {
  const first = args[0];
  if (Array.isArray(first)) return guardedPort(first);
  const value = typeof first === 'object' && first !== null ? first.port : first;
  if (value === undefined || value === null || !/^\d+$/.test(String(value))) return null;
  return Number(value);
}

function checkPort(args, operation, record) {
  if (guardedPort(args) !== 9880) return;
  record('blocked-network', { operation, port: 9880 });
  throw new Error(`Test harness blocked ${operation} to live port 9880`);
}

function loopbackListen(args, allowed) {
  const port = guardedPort(args);
  assert(port !== null && allowed.includes(port), `Test process attempted unexpected listen: ${port}`);
  if (typeof args[0] === 'object') return [{ ...args[0], host: '127.0.0.1' }, ...args.slice(1)];
  if (typeof args[1] === 'string') return [args[0], '127.0.0.1', ...args.slice(2)];
  return [args[0], '127.0.0.1', ...args.slice(1)];
}

function patch(proto, method, operation, record, transform = args => args) {
  const original = proto[method];
  proto[method] = function (...args) {
    checkPort(args, operation, record);
    return Reflect.apply(original, this, transform(args));
  };
}

export function installGuards(record, ports) {
  patch(net.Socket.prototype, 'connect', 'connect', record);
  patch(net.Server.prototype, 'listen', 'listen', record, args => loopbackListen(args, ports));
  patch(dgram.Socket.prototype, 'connect', 'udp-connect', record);
  patch(dgram.Socket.prototype, 'bind', 'udp-bind', record);
  syncBuiltinESMExports();
}
