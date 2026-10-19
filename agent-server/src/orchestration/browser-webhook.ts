// `/webhook/browser`: the daemon side of `cortex-browser`. The CLI leases the session's browser
// here, then runs agent-browser itself so its output streams straight to the agent.

import {
  BrowserLeaseError, leaseBrowser, noteBrowserCommand, agentBrowserRuntime, type BrowserBroker,
} from '@domain/browser/broker.js';

export interface BrowserWebhookReply {
  success: boolean;
  data?: unknown;
  error?: string;
  hint?: string;
  code?: string;
}

type BrokerSlice = Pick<BrowserBroker, 'leaseBrowser' | 'noteBrowserCommand' | 'agentBrowserRuntime'>;

const defaultBroker: BrokerSlice = { leaseBrowser, noteBrowserCommand, agentBrowserRuntime };

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export async function handleBrowserWebhook(
  data: Record<string, any>,
  broker: BrokerSlice = defaultBroker,
): Promise<BrowserWebhookReply> {
  const sessionId = str(data.sessionId);
  try {
    if (data.action === 'lease') {
      const lease = await broker.leaseBrowser({ sessionId, device: str(data.device) || null });
      const { bin, env } = broker.agentBrowserRuntime();
      return { success: true, data: { ...lease, bin, env } };
    }
    if (data.action === 'report') {
      broker.noteBrowserCommand(sessionId);
      return { success: true };
    }
    return { success: false, error: `unknown action: ${String(data.action)}`, hint: 'valid actions: lease, report' };
  } catch (e) {
    if (e instanceof BrowserLeaseError) {
      return { success: false, error: e.message, code: e.code, ...(e.hint ? { hint: e.hint } : {}) };
    }
    return { success: false, error: (e as Error).message };
  }
}
