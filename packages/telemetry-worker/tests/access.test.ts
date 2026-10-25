import test from 'node:test';
import assert from 'node:assert/strict';
import { accessConfig, claimsValid, createAccessVerifier, type AccessConfig } from '../src/access.js';
import type { Env } from '../src/env.js';
import { handleRequest } from '../src/index.js';
import { NOW } from './fixtures.js';
import { sqliteD1 } from './helpers/sqlite-d1.js';

const TEAM = 'example-team.cloudflareaccess.com';
const CONFIG: AccessConfig = { teamDomain: TEAM, audience: 'aud-tag-1234' };
const RS256 = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;
const nowS = Math.floor(NOW.getTime() / 1000);

async function rsaKeys(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    { ...RS256, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ['sign', 'verify'],
  ) as Promise<CryptoKeyPair>;
}

function b64url(bytes: Uint8Array | string): string {
  const buffer = typeof bytes === 'string' ? Buffer.from(bytes) : Buffer.from(bytes);
  return buffer.toString('base64url');
}

async function sign(key: CryptoKey, claims: Record<string, unknown>, header: Record<string, unknown> = {}): Promise<string> {
  const head = b64url(JSON.stringify({ alg: 'RS256', kid: 'key-1', typ: 'JWT', ...header }));
  const body = b64url(JSON.stringify(claims));
  const signature = await crypto.subtle.sign(RS256, key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(signature))}`;
}

function goodClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { aud: [CONFIG.audience], iss: `https://${TEAM}`, exp: nowS + 600, iat: nowS - 10, nbf: nowS - 10, ...overrides };
}

async function certsServer(keys: CryptoKeyPair, kid = 'key-1') {
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
  const calls: string[] = [];
  const fetchCerts = async (url: string) => {
    calls.push(url);
    return Response.json({ keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] });
  };
  return { calls, fetchCerts };
}

test('a correctly signed Access token passes and the certs are cached', async () => {
  const keys = await rsaKeys();
  const certs = await certsServer(keys);
  const verifier = createAccessVerifier(certs.fetchCerts, () => NOW.getTime());
  const token = await sign(keys.privateKey, goodClaims());
  assert.equal(await verifier.verify(token, CONFIG), true);
  assert.equal(await verifier.verify(token, CONFIG), true);
  assert.deepEqual(certs.calls, [`https://${TEAM}/cdn-cgi/access/certs`]);
});

test('wrong audience, issuer, expiry or not-before fail', async () => {
  const keys = await rsaKeys();
  const verifier = createAccessVerifier((await certsServer(keys)).fetchCerts, () => NOW.getTime());
  const cases = [
    goodClaims({ aud: ['another-app'] }),
    goodClaims({ aud: undefined }),
    goodClaims({ iss: 'https://evil.cloudflareaccess.com' }),
    goodClaims({ exp: nowS - 120 }),
    goodClaims({ exp: undefined }),
    goodClaims({ nbf: nowS + 600 }),
  ];
  for (const claims of cases) {
    assert.equal(await verifier.verify(await sign(keys.privateKey, claims), CONFIG), false, JSON.stringify(claims));
  }
  assert.equal(claimsValid(goodClaims({ aud: CONFIG.audience }), CONFIG, nowS), true);
});

test('a token signed by another key, a forged alg or garbage fails', async () => {
  const keys = await rsaKeys();
  const verifier = createAccessVerifier((await certsServer(keys)).fetchCerts, () => NOW.getTime());
  const intruder = await rsaKeys();
  assert.equal(await verifier.verify(await sign(intruder.privateKey, goodClaims()), CONFIG), false);
  assert.equal(await verifier.verify(await sign(keys.privateKey, goodClaims(), { alg: 'HS256' }), CONFIG), false);
  const [head, body] = (await sign(keys.privateKey, goodClaims())).split('.');
  const unsigned = `${b64url(JSON.stringify({ alg: 'none', kid: 'key-1' }))}.${body}.`;
  assert.equal(await verifier.verify(unsigned, CONFIG), false);
  assert.equal(await verifier.verify(`${head}.${body}`, CONFIG), false);
  assert.equal(await verifier.verify('not.a.jwt', CONFIG), false);
  assert.equal(await verifier.verify(await sign(keys.privateKey, goodClaims(), { kid: 'unknown' }), CONFIG), false);
});

test('an unknown key id refetches the certs once the refetch floor has passed', async () => {
  const keys = await rsaKeys();
  const certs = await certsServer(keys, 'key-2');
  let clock = NOW.getTime();
  const verifier = createAccessVerifier(certs.fetchCerts, () => clock);
  const token = await sign(keys.privateKey, goodClaims(), { kid: 'key-2' });
  assert.equal(await verifier.verify(await sign(keys.privateKey, goodClaims(), { kid: 'key-9' }), CONFIG), false);
  assert.equal(await verifier.verify(await sign(keys.privateKey, goodClaims(), { kid: 'key-9' }), CONFIG), false);
  assert.equal(certs.calls.length, 1);
  clock += 61_000;
  assert.equal(await verifier.verify(await sign(keys.privateKey, goodClaims(), { kid: 'key-9' }), CONFIG), false);
  assert.equal(certs.calls.length, 2);
  assert.equal(await verifier.verify(token, CONFIG), true);
});

test('accessConfig needs both values and normalizes the team domain', () => {
  const db = sqliteD1().db;
  assert.equal(accessConfig({ DB: db }), null);
  assert.equal(accessConfig({ DB: db, ACCESS_TEAM_DOMAIN: TEAM }), null);
  assert.equal(accessConfig({ DB: db, ACCESS_AUD: 'x' }), null);
  assert.deepEqual(accessConfig({ DB: db, ACCESS_TEAM_DOMAIN: `https://${TEAM}/`, ACCESS_AUD: ' aud ' }), {
    teamDomain: TEAM, audience: 'aud',
  });
});

test('the dashboard fails closed: 404 unconfigured, 403 without a valid token, 200 with one', async () => {
  const keys = await rsaKeys();
  const verifier = createAccessVerifier((await certsServer(keys)).fetchCerts, () => NOW.getTime());
  const deps = { verifier, now: NOW };
  const db = sqliteD1().db;
  const url = 'https://telemetry.example.com/dashboard';
  const configured: Env = { DB: db, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: CONFIG.audience };

  assert.equal((await handleRequest(new Request(url), { DB: db }, deps)).status, 404);
  assert.equal((await handleRequest(new Request(url), configured, deps)).status, 403);
  const forged = await sign((await rsaKeys()).privateKey, goodClaims());
  const forgedRequest = new Request(url, { headers: { 'cf-access-jwt-assertion': forged } });
  assert.equal((await handleRequest(forgedRequest, configured, deps)).status, 403);

  const token = await sign(keys.privateKey, goodClaims());
  const response = await handleRequest(new Request(url, { headers: { 'cf-access-jwt-assertion': token } }), configured, deps);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/html/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('the local bypass only opens the dashboard on a loopback host', async () => {
  const deps = { verifier: createAccessVerifier(async () => { throw new Error('no certs'); }), now: NOW };
  const env: Env = { DB: sqliteD1().db, DASHBOARD_LOCAL_BYPASS: '1' };
  assert.equal((await handleRequest(new Request('http://localhost:8787/dashboard'), env, deps)).status, 200);
  assert.equal((await handleRequest(new Request('http://127.0.0.1:8787/dashboard'), env, deps)).status, 200);
  assert.equal((await handleRequest(new Request('https://telemetry.example.com/dashboard'), env, deps)).status, 404);
  const configured = { ...env, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: CONFIG.audience };
  assert.equal((await handleRequest(new Request('https://telemetry.example.com/dashboard'), configured, deps)).status, 403);
});
