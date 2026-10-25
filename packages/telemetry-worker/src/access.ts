/**
 * Cloudflare Access JWT check for the dashboard. Access already gates the route at the edge; the
 * Worker verifies the forwarded `Cf-Access-Jwt-Assertion` itself so a misconfigured or bypassed
 * Access application still cannot expose the page.
 */
import type { Env } from './env.js';

export const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';
const CERTS_TTL_MS = 60 * 60 * 1000;
/** A token signed by an unknown key forces a refetch, but at most this often (key rotation). */
const REFETCH_FLOOR_MS = 60 * 1000;
const CLOCK_SKEW_S = 60;
const RS256 = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;

export interface AccessConfig {
  teamDomain: string;
  audience: string;
}

export type CertsFetch = (url: string) => Promise<Response>;

interface JwtClaims {
  aud?: unknown;
  iss?: unknown;
  exp?: unknown;
  nbf?: unknown;
}

interface DecodedJwt {
  alg: unknown;
  kid: unknown;
  claims: JwtClaims;
  signed: Uint8Array<ArrayBuffer>;
  signature: Uint8Array<ArrayBuffer>;
}

interface CachedKeys {
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
}

/** Null (dashboard stays dark) unless both Access settings are present. */
export function accessConfig(env: Env): AccessConfig | null {
  const teamDomain = env.ACCESS_TEAM_DOMAIN?.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const audience = env.ACCESS_AUD?.trim();
  return teamDomain && audience ? { teamDomain, audience } : null;
}

function base64UrlBytes(segment: string): Uint8Array<ArrayBuffer> {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function base64UrlJson(segment: string): Record<string, unknown> {
  const value: unknown = JSON.parse(new TextDecoder().decode(base64UrlBytes(segment)));
  if (!value || typeof value !== 'object') throw new Error('JWT segment is not an object');
  return value as Record<string, unknown>;
}

function decodeJwt(token: string): DecodedJwt | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = base64UrlJson(parts[0]);
    return {
      alg: header.alg,
      kid: header.kid,
      claims: base64UrlJson(parts[1]),
      signed: new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
      signature: base64UrlBytes(parts[2]),
    };
  } catch {
    return null;
  }
}

export function claimsValid(claims: JwtClaims, config: AccessConfig, nowS: number): boolean {
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const notBefore = typeof claims.nbf === 'number' ? claims.nbf : 0;
  return audiences.includes(config.audience)
    && claims.iss === `https://${config.teamDomain}`
    && typeof claims.exp === 'number' && claims.exp + CLOCK_SKEW_S > nowS
    && notBefore - CLOCK_SKEW_S <= nowS;
}

async function importJwk(jwk: JsonWebKey & { kid?: unknown }): Promise<[string, CryptoKey] | null> {
  if (jwk.kty !== 'RSA' || typeof jwk.kid !== 'string') return null;
  const { kid, ...material } = jwk;
  return [kid, await crypto.subtle.importKey('jwk', material, RS256, false, ['verify'])];
}

async function fetchKeys(fetchCerts: CertsFetch, teamDomain: string): Promise<Map<string, CryptoKey>> {
  const response = await fetchCerts(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error(`Access certs request failed: ${response.status}`);
  const body = await response.json() as { keys?: Array<JsonWebKey & { kid?: unknown }> };
  const entries = await Promise.all((body.keys ?? []).map(importJwk));
  return new Map(entries.filter(entry => entry !== null));
}

export interface AccessVerifier {
  verify(token: string, config: AccessConfig): Promise<boolean>;
}

export function createAccessVerifier(
  fetchCerts: CertsFetch = url => fetch(url),
  clock: () => number = Date.now,
): AccessVerifier {
  const cache = new Map<string, CachedKeys>();

  async function signingKey(teamDomain: string, kid: string): Promise<CryptoKey | null> {
    const cached = cache.get(teamDomain);
    const age = cached ? clock() - cached.fetchedAt : Infinity;
    const fresh = cached && age < CERTS_TTL_MS && (cached.keys.has(kid) || age < REFETCH_FLOOR_MS);
    if (fresh) return cached.keys.get(kid) ?? null;
    const keys = await fetchKeys(fetchCerts, teamDomain);
    cache.set(teamDomain, { keys, fetchedAt: clock() });
    return keys.get(kid) ?? null;
  }

  async function verify(token: string, config: AccessConfig): Promise<boolean> {
    const jwt = decodeJwt(token);
    if (!jwt || jwt.alg !== 'RS256' || typeof jwt.kid !== 'string') return false;
    if (!claimsValid(jwt.claims, config, Math.floor(clock() / 1000))) return false;
    try {
      const key = await signingKey(config.teamDomain, jwt.kid);
      return key !== null && await crypto.subtle.verify(RS256, key, jwt.signature, jwt.signed);
    } catch (error) {
      console.error('Access JWT verification failed:', error);
      return false;
    }
  }

  return { verify };
}
