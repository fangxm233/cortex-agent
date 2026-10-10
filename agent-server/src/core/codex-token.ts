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
