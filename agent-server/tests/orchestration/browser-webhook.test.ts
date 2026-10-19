import { describe, expect, it, vi } from 'vitest';
import { handleBrowserWebhook } from '../../src/orchestration/browser-webhook.js';
import { BrowserLeaseError } from '../../src/domain/browser/broker.js';

function broker(overrides: Record<string, unknown> = {}) {
  return {
    leaseBrowser: vi.fn(async ({ device }: { device?: string | null }) => ({
      device: device ?? 'server', cdpEndpoint: 'http://127.0.0.1:9222', abSession: 'cortex-s-server',
    })),
    noteBrowserCommand: vi.fn(),
    agentBrowserRuntime: vi.fn(() => ({ bin: '/opt/ab', env: { PATH: '/bin' } })),
    ...overrides,
  };
}

describe('handleBrowserWebhook', () => {
  it('leases and returns how to reach the browser', async () => {
    const b = broker();
    const reply = await handleBrowserWebhook({ action: 'lease', sessionId: ' s ', device: 'desk' }, b);
    expect(b.leaseBrowser).toHaveBeenCalledWith({ sessionId: 's', device: 'desk' });
    expect(reply).toEqual({
      success: true,
      data: { device: 'desk', cdpEndpoint: 'http://127.0.0.1:9222', abSession: 'cortex-s-server', bin: '/opt/ab', env: { PATH: '/bin' } },
    });
  });

  it('passes a missing device as null so the session keeps its last one', async () => {
    const b = broker();
    await handleBrowserWebhook({ action: 'lease', sessionId: 's' }, b);
    expect(b.leaseBrowser).toHaveBeenCalledWith({ sessionId: 's', device: null });
  });

  it('carries the lease error code and hint', async () => {
    const b = broker({
      leaseBrowser: vi.fn(async () => { throw new BrowserLeaseError('taken-over', 'the user is controlling this browser right now', 'wait'); }),
    });
    expect(await handleBrowserWebhook({ action: 'lease', sessionId: 's' }, b)).toEqual({
      success: false, error: 'the user is controlling this browser right now', code: 'taken-over', hint: 'wait',
    });
  });

  it('records a finished command', async () => {
    const b = broker();
    expect(await handleBrowserWebhook({ action: 'report', sessionId: 's' }, b)).toEqual({ success: true });
    expect(b.noteBrowserCommand).toHaveBeenCalledWith('s');
  });

  it('rejects an unknown action with the valid ones', async () => {
    expect(await handleBrowserWebhook({ action: 'nope' }, broker())).toMatchObject({ success: false, hint: 'valid actions: lease, report' });
  });
});
