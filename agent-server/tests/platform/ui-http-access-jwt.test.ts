// input:  Node test runner + createUiHttpServer (transport-host) + a FAKE tRPC router +
//         createAccessJwtVerifier/accessVerifierFromEnv (access-jwt) + a synthetic local JWKS
//         served over http, signing tokens with jose (RS256 + ES256 keypairs).
// output: dual-path auth-gate tests (task 50c7) — valid x-cortex-token passes; a validly-signed
//         Cf-Access-Jwt-Assertion (correct aud/iss, unexpired, key in JWKS) passes; bad-signature /
//         wrong-aud / wrong-iss / expired JWT → 401; no credentials → 401; env-driven verifier
//         construction (present when team+aud configured, undefined = secure-degrade otherwise).
// pos:    Regression guard for the Cloudflare Access JWT leg of the Web UI tRPC auth gate.
//         The x-cortex-token byte-for-byte behaviour stays covered by ui-http-server.test.ts.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import '../_test-home.js'; // MUST be first: isolate CORTEX_HOME before paths.ts loads
import { test, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { initTRPC } from '@trpc/server';
import { z } from 'zod';
import { generateKeyPair, exportJWK, SignJWT, type JWK, type CryptoKey } from 'jose';
import { createUiHttpServer } from '@platform/ui-http/ui-http-server.js';
import { createAccessJwtVerifier, accessVerifierFromEnv } from '@platform/ui-http/access-jwt.js';

const TOKEN = 'test-ui-token-xyz';
const ACCESS_HEADER = 'cf-access-jwt-assertion';
const ISSUER = 'https://myteam.cloudflareaccess.com';
const AUD = 'test-aud-tag-0123456789abcdef';

// ── Fake tRPC router (no dependency on the real AppRouter) ──
const t = initTRPC.create();
const fakeRouter = t.router({
  ping: t.procedure.input(z.object({ v: z.string() })).query(({ input }) => ({ echoed: input.v })),
});

// ── Synthetic JWKS: a local http server returning { keys: [...] } ──
interface Keypair { priv: CryptoKey; pub: CryptoKey; jwk: JWK }
async function makeKeypair(alg: 'RS256' | 'ES256', kid: string): Promise<Keypair> {
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg, use: 'sig' } as JWK;
  return { priv: privateKey, pub: publicKey, jwk };
}

const jwksServers: http.Server[] = [];
async function startJwks(jwks: JWK[]): Promise<string> {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ keys: jwks }));
  });
  jwksServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no JWKS addr');
  return `http://127.0.0.1:${addr.port}/certs`;
}

async function signJwt(
  key: CryptoKey,
  kid: string,
  alg: 'RS256' | 'ES256',
  opts: { iss?: string; aud?: string; exp?: string } = {},
): Promise<string> {
  return new SignJWT({ email: 'user@example.com' })
    .setProtectedHeader({ alg, kid })
    .setIssuedAt()
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? AUD)
    .setExpirationTime(opts.exp ?? '2h')
    .sign(key);
}

const uiServers: Array<{ close: () => Promise<void> }> = [];
afterAll(async () => {
  for (const s of uiServers) await s.close().catch(() => {});
  for (const s of jwksServers) await new Promise<void>((r) => s.close(() => r()));
});

async function boot(opts: { jwksUrl?: string; audience?: string; issuer?: string } = {}) {
  const verifyAccessJwt = opts.jwksUrl
    ? createAccessJwtVerifier({
        jwksUrl: opts.jwksUrl,
        audience: opts.audience ?? AUD,
        issuer: opts.issuer ?? ISSUER,
      })
    : undefined;
  const inst = createUiHttpServer({
    router: fakeRouter,
    getToken: () => TOKEN,
    port: 0,
    host: '127.0.0.1',
    verifyAccessJwt,
  });
  uiServers.push(inst);
  if (!inst.server.listening) {
    await new Promise<void>((resolve, reject) => {
      inst.server.once('listening', () => resolve());
      inst.server.once('error', reject);
    });
  }
  const addr = inst.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no TCP address');
  return { port: addr.port };
}

interface Res { statusCode: number; body: string }
function get(port: number, urlPath: string, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
  });
}

function pingPath(): string {
  return `/trpc/ping?input=${encodeURIComponent(JSON.stringify({ v: 'hi' }))}`;
}

// ── token path (unchanged behaviour, cross-checked here too) ──
test('dual-gate: valid x-cortex-token passes even with a verifier configured', async () => {
  const url = await startJwks([(await makeKeypair('RS256', 'k1')).jwk]);
  const { port } = await boot({ jwksUrl: url });
  const { statusCode, body } = await get(port, pingPath(), { 'x-cortex-token': TOKEN });
  assert.equal(statusCode, 200);
  assert.deepEqual(JSON.parse(body).result.data, { echoed: 'hi' });
});

test('dual-gate: no credentials → 401', async () => {
  const url = await startJwks([(await makeKeypair('RS256', 'k1')).jwk]);
  const { port } = await boot({ jwksUrl: url });
  const { statusCode } = await get(port, pingPath());
  assert.equal(statusCode, 401);
});

// ── Access-JWT path: valid ──
test('dual-gate: valid RS256 Access JWT (correct aud/iss, unexpired) passes', async () => {
  const kp = await makeKeypair('RS256', 'rs-1');
  const url = await startJwks([kp.jwk]);
  const { port } = await boot({ jwksUrl: url });
  const jwt = await signJwt(kp.priv, 'rs-1', 'RS256');
  const { statusCode, body } = await get(port, pingPath(), { [ACCESS_HEADER]: jwt });
  assert.equal(statusCode, 200);
  assert.deepEqual(JSON.parse(body).result.data, { echoed: 'hi' });
});

test('dual-gate: valid ES256 Access JWT passes (EC keypair)', async () => {
  const kp = await makeKeypair('ES256', 'ec-1');
  const url = await startJwks([kp.jwk]);
  const { port } = await boot({ jwksUrl: url });
  const jwt = await signJwt(kp.priv, 'ec-1', 'ES256');
  const { statusCode } = await get(port, pingPath(), { [ACCESS_HEADER]: jwt });
  assert.equal(statusCode, 200);
});

// ── Access-JWT path: rejected ──
test('dual-gate: bad-signature JWT → 401 (signed by a different key, same kid in JWKS)', async () => {
  const good = await makeKeypair('RS256', 'rs-1');
  const attacker = await makeKeypair('RS256', 'rs-1'); // same kid, different key
  const url = await startJwks([good.jwk]);              // JWKS advertises only the good key
  const { port } = await boot({ jwksUrl: url });
  const jwt = await signJwt(attacker.priv, 'rs-1', 'RS256');
  const { statusCode } = await get(port, pingPath(), { [ACCESS_HEADER]: jwt });
  assert.equal(statusCode, 401);
});

test('dual-gate: wrong-aud JWT → 401', async () => {
  const kp = await makeKeypair('RS256', 'rs-1');
  const url = await startJwks([kp.jwk]);
  const { port } = await boot({ jwksUrl: url });
  const jwt = await signJwt(kp.priv, 'rs-1', 'RS256', { aud: 'some-other-aud' });
  const { statusCode } = await get(port, pingPath(), { [ACCESS_HEADER]: jwt });
  assert.equal(statusCode, 401);
});

test('dual-gate: wrong-iss JWT → 401', async () => {
  const kp = await makeKeypair('RS256', 'rs-1');
  const url = await startJwks([kp.jwk]);
  const { port } = await boot({ jwksUrl: url });
  const jwt = await signJwt(kp.priv, 'rs-1', 'RS256', { iss: 'https://evil.cloudflareaccess.com' });
  const { statusCode } = await get(port, pingPath(), { [ACCESS_HEADER]: jwt });
  assert.equal(statusCode, 401);
});

test('dual-gate: expired JWT → 401', async () => {
  const kp = await makeKeypair('RS256', 'rs-1');
  const url = await startJwks([kp.jwk]);
  const { port } = await boot({ jwksUrl: url });
  const jwt = await signJwt(kp.priv, 'rs-1', 'RS256', { exp: '-1h' });
  const { statusCode } = await get(port, pingPath(), { [ACCESS_HEADER]: jwt });
  assert.equal(statusCode, 401);
});

test('dual-gate: Access JWT presented but no verifier configured (unset env) → 401', async () => {
  const kp = await makeKeypair('RS256', 'rs-1');
  const jwt = await signJwt(kp.priv, 'rs-1', 'RS256');
  const { port } = await boot(); // no jwksUrl → verifyAccessJwt undefined (secure degrade)
  const { statusCode } = await get(port, pingPath(), { [ACCESS_HEADER]: jwt });
  assert.equal(statusCode, 401);
});

// ── env-driven verifier construction (secure degrade) ──
test('accessVerifierFromEnv: team-domain + aud present → returns a verifier', () => {
  const v = accessVerifierFromEnv({ CORTEX_ACCESS_TEAM_DOMAIN: 'myteam', CORTEX_ACCESS_AUD: AUD });
  assert.equal(typeof v, 'function');
});

test('accessVerifierFromEnv: missing team-domain → undefined (token-only degrade)', () => {
  assert.equal(accessVerifierFromEnv({ CORTEX_ACCESS_AUD: AUD }), undefined);
});

test('accessVerifierFromEnv: missing aud → undefined (token-only degrade)', () => {
  assert.equal(accessVerifierFromEnv({ CORTEX_ACCESS_TEAM_DOMAIN: 'myteam' }), undefined);
});

test('accessVerifierFromEnv: both missing → undefined', () => {
  assert.equal(accessVerifierFromEnv({}), undefined);
});
