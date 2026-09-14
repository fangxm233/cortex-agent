// input:  an AccessJwtConfig (JWKS URL + aud + iss) OR the process env (team-domain / aud / certs URL)
// output: createAccessJwtVerifier(cfg) -> (token) => Promise<boolean> and
//         accessVerifierFromEnv(env) -> AccessJwtVerifier | undefined
// pos:    Cloudflare Access JWT leg of the Web UI tRPC auth gate, in-core (platform/ui-http).
//         Verifies the `Cf-Access-Jwt-Assertion` JWT the Cloudflare edge injects after it
//         authenticates the browser: signature against the Access team-domain JWKS
//         (https://<team>.cloudflareaccess.com/cdn-cgi/access/certs), plus audience (AUD tag) +
//         issuer + expiry. The browser NEVER holds the clientToken — this is the browser auth path.
//         Uses `jose` (createRemoteJWKSet caches + selects the signing key by kid; jwtVerify does
//         signature/aud/iss/exp in one shot). Algorithms are pinned to RS256/ES256 to reject
//         `alg:none` / HS256 confusion. Config is env-driven; when team-domain or AUD is unset,
//         accessVerifierFromEnv returns undefined so the gate degrades to token-only (fail-closed —
//         an unconfigured Access path never admits a request).

import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createLogger } from '@core/log.js';

const log = createLogger('ui-http');

/** Cloudflare Access uses RS256; EC (ES256) is allowed too. Pinned to reject alg confusion. */
const ALLOWED_ALGS = ['RS256', 'ES256'];

export interface AccessJwtConfig {
  /** Full JWKS URL, e.g. https://<team>.cloudflareaccess.com/cdn-cgi/access/certs */
  jwksUrl: string;
  /** Access application AUD tag the token's `aud` claim must contain. */
  audience: string;
  /** Expected token issuer, e.g. https://<team>.cloudflareaccess.com */
  issuer: string;
}

/** Verifies a Cloudflare Access assertion JWT. Resolves true iff signature + aud + iss + exp pass. */
export type AccessJwtVerifier = (token: string) => Promise<boolean>;

/**
 * Build a verifier bound to one Access team-domain JWKS + aud + iss. The remote JWKS is fetched
 * lazily on first use and cached (kid-indexed) by jose. Any verification failure — bad signature,
 * wrong aud/iss, expired, malformed token, unreachable JWKS — resolves false (never throws through),
 * so the caller can treat it as a plain allow/deny.
 */
export function createAccessJwtVerifier(cfg: AccessJwtConfig): AccessJwtVerifier {
  const jwks = createRemoteJWKSet(new URL(cfg.jwksUrl));
  return async (token: string): Promise<boolean> => {
    try {
      await jwtVerify(token, jwks, {
        audience: cfg.audience,
        issuer: cfg.issuer,
        algorithms: ALLOWED_ALGS,
      });
      return true;
    } catch {
      return false;
    }
  };
}

/** Normalize a configured team domain into its full `<team>.cloudflareaccess.com` host. */
function teamHost(teamDomain: string): string {
  const t = teamDomain.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return t.includes('.') ? t : `${t}.cloudflareaccess.com`;
}

/**
 * Construct an Access JWT verifier from env, or undefined when Access is not configured.
 *
 *   CORTEX_ACCESS_TEAM_DOMAIN  bare team name (`myteam`) or full host (`myteam.cloudflareaccess.com`)
 *   CORTEX_ACCESS_AUD          the Access application AUD tag
 *   CORTEX_ACCESS_CERTS_URL    (optional) overrides the derived JWKS URL
 *
 * Returning undefined when team-domain OR aud is absent is the secure-degrade path: the auth gate
 * keeps only the x-cortex-token route rather than admitting requests on an unconfigured Access app.
 */
export function accessVerifierFromEnv(env: NodeJS.ProcessEnv): AccessJwtVerifier | undefined {
  const teamDomain = (env.CORTEX_ACCESS_TEAM_DOMAIN || '').trim();
  const audience = (env.CORTEX_ACCESS_AUD || '').trim();
  if (!teamDomain || !audience) return undefined;

  const host = teamHost(teamDomain);
  const issuer = `https://${host}`;
  const jwksUrl = (env.CORTEX_ACCESS_CERTS_URL || '').trim() || `${issuer}/cdn-cgi/access/certs`;
  log.info(`Cloudflare Access JWT verification enabled (iss: ${issuer})`);
  return createAccessJwtVerifier({ jwksUrl, audience, issuer });
}
