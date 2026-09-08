// input:  @larksuiteoapi/node-sdk, env (FEISHU_APP_ID/SECRET/DOMAIN/AUTH_MODE), user-auth
// output: buildFeishuClientFromEnv() → lark.Client | null (null when unconfigured);
//         wrapWithUserToken() to act as a Feishu user (FEISHU_AUTH_MODE=user)
// pos:    Shared Feishu OpenAPI client for all feishu_* MCP doc tools. In user mode every
//         leaf API call is auto-tagged with the operator's user_access_token; messaging
//         (platform/adapters/feishu.ts) is separate and always stays bot/app identity.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type * as lark from '@larksuiteoapi/node-sdk';
import { createRequire } from 'node:module';
import { getValidUserAccessToken, type FeishuDomain } from './user-auth.js';

/**
 * Lazy SDK handle — see platform/adapters/feishu.ts for the full rationale: a static `import` of
 * this 5MB CJS bundle costs ~20MB of heap because Node keeps a second interop copy of the source.
 * `createRequire` drops that copy, and deferring the load keeps merely importing this module cheap.
 */
let larkSdk: typeof lark | null = null;
function sdk(): typeof lark {
  if (!larkSdk) larkSdk = createRequire(import.meta.url)('@larksuiteoapi/node-sdk') as typeof lark;
  return larkSdk;
}

export type LarkClient = lark.Client;

export interface FeishuClientConfig {
  appId: string;
  appSecret: string;
  domain?: 'feishu' | 'lark';
}

/**
 * Logger that routes ALL lark SDK output to stderr. CRITICAL for the cortex-feishu MCP server:
 * it speaks the MCP JSON-RPC protocol over stdout, but the lark SDK logs via console.log (stdout)
 * by default. Any SDK info/error log emitted during a tool call (e.g. a Feishu API permission
 * error) would otherwise interleave with the protocol stream and corrupt the response. Console.error
 * writes to stderr, which the MCP transport ignores.
 */
export const stderrLogger = {
  error: (...m: unknown[]): void => console.error('[lark:error]', ...m),
  warn: (...m: unknown[]): void => console.error('[lark:warn]', ...m),
  info: (...m: unknown[]): void => console.error('[lark:info]', ...m),
  debug: (...m: unknown[]): void => console.error('[lark:debug]', ...m),
  trace: (...m: unknown[]): void => console.error('[lark:trace]', ...m),
};

/** Construct a Feishu OpenAPI client (mirrors FeishuAdapter's constructor). */
export function createFeishuClient(config: FeishuClientConfig): LarkClient {
  const domain = config.domain === 'lark' ? sdk().Domain.Lark : sdk().Domain.Feishu;
  return new (sdk().Client)({
    appId: config.appId,
    appSecret: config.appSecret,
    appType: sdk().AppType.SelfBuild,
    domain,
    // Force SDK logs to stderr — stdout carries the MCP JSON-RPC protocol (see stderrLogger).
    logger: stderrLogger,
    loggerLevel: sdk().LoggerLevel.warn,
  });
}

/**
 * Wrap a lark client so EVERY leaf API call (e.g. client.docx.v1.document.create)
 * is automatically tagged with a freshly-resolved user_access_token via
 * lark.withUserAccessToken — without editing each of the ~35 tool call sites.
 *
 * A recursive Proxy descends the resource tree (returning child proxies for objects)
 * and, on a method call, resolves the token first then invokes the real method with the
 * token option appended. The token is fetched per call so refreshes are picked up, and a
 * failing provider rejects the call (surfaced by guard()) — it never falls back to bot auth.
 */
export function wrapWithUserToken(client: LarkClient, getToken: () => Promise<string>): LarkClient {
  const wrap = (target: any): any =>
    new Proxy(target, {
      get(t, prop, receiver) {
        const value = Reflect.get(t, prop, receiver);
        if (typeof value === 'function') {
          return (payload: unknown, options?: { lark?: Record<string | symbol, unknown> }) =>
            getToken().then((token) => {
              const tokenOpt = sdk().withUserAccessToken(token);
              const merged = { ...(options ?? {}), lark: { ...(options?.lark ?? {}), ...tokenOpt.lark } };
              return value.call(t, payload, merged);
            });
        }
        if (value && typeof value === 'object') return wrap(value);
        return value;
      },
    });
  return wrap(client) as LarkClient;
}

/**
 * Build a client from environment variables. Returns null when credentials are
 * absent so the server can register tools that fail with a friendly message
 * rather than crashing at startup.
 *
 * FEISHU_AUTH_MODE selects identity for document operations (binary, no fallback):
 *   - 'bot' (default): app/tenant identity (docs owned by the bot).
 *   - 'user': the operator's Feishu account (docs owned by the user). App credentials are
 *     still required (used to refresh the user token). A missing/expired user token makes
 *     doc tools fail with a re-login hint rather than silently reverting to bot identity.
 */
export function buildFeishuClientFromEnv(env: NodeJS.ProcessEnv = process.env): LarkClient | null {
  const appId = env.FEISHU_APP_ID;
  const appSecret = env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) return null;
  const domain = (env.FEISHU_DOMAIN as FeishuDomain) || undefined;
  const client = createFeishuClient({ appId, appSecret, domain });
  if (env.FEISHU_AUTH_MODE === 'user') {
    return wrapWithUserToken(client, () =>
      getValidUserAccessToken({ appId, appSecret, domain }),
    );
  }
  return client;
}
