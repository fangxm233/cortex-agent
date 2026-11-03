/** Decode a JWT's payload segment. Null when the token is not a decodable JWT. */
export function decodeJwtPayload(token: string): unknown {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/** The ChatGPT account id a Codex OAuth token is bound to, wherever the claim sits in the payload. */
export function findChatgptAccountId(payload: unknown): string | undefined {
  const queue: unknown[] = [payload];
  while (queue.length > 0) {
    const value = queue.shift();
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    if (typeof record.chatgpt_account_id === 'string') return record.chatgpt_account_id;
    queue.push(...Object.values(record));
  }
  return undefined;
}

/** The first string a payload holds under `key`, at any depth. */
function findClaim(payload: unknown, key: string): string | null {
  const queue: unknown[] = [payload];
  while (queue.length > 0) {
    const value = queue.shift();
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    if (typeof record[key] === 'string') return record[key];
    queue.push(...Object.values(record));
  }
  return null;
}

/** Who a ChatGPT sign-in token belongs to: its email and plan, where the token records them. */
export function chatgptIdentity(token: string): { email: string | null; plan: string | null } {
  const payload = decodeJwtPayload(token);
  return { email: findClaim(payload, 'email'), plan: findClaim(payload, 'chatgpt_plan_type') };
}
