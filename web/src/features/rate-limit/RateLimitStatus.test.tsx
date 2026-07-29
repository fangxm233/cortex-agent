// input:  RateLimitView fixtures rendered through the desktop popover trigger
// output: regressions pinning Radix trigger prop forwarding on the desktop pill
// pos:    Verifies the desktop rate-limit button actually opens its popover
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DesktopRateLimitStatus } from './RateLimitStatus';
import type { RateLimitView } from './rate-limit-vm';

function status(): RateLimitView {
  return {
    lang: 'en',
    label: 'OpenAI Codex · outage · 5m',
    firstRecoveryAt: 1_000,
    providers: [
      {
        provider: 'openai-codex',
        displayName: 'OpenAI Codex',
        recoveryAt: 1_000,
        recoveryCountdown: '5m',
        waitingSessions: 0,
        waitingThreads: 1,
        waitingLabel: '0 sessions · 1 thread waiting',
        windows: [
          { type: 'outage', typeLabel: 'outage', utilization: null, resetsAt: 1_000, countdown: '5m' },
        ],
      },
    ],
  };
}

describe('DesktopRateLimitStatus', () => {
  // Radix Popover.Trigger uses asChild cloning: it injects its interaction props
  // (onClick, aria-haspopup, aria-expanded, data-state) into the trigger element.
  // If the trigger component drops unknown props, the popover can never open.
  // The aria/data attributes are the statically-renderable face of that same spread.
  it('forwards Radix trigger props onto the pill button', () => {
    const html = renderToStaticMarkup(<DesktopRateLimitStatus status={status()} />);
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('data-state="closed"');
    expect(html).toContain('aria-expanded="false"');
  });

  it('renders nothing without an active throttle', () => {
    expect(renderToStaticMarkup(<DesktopRateLimitStatus status={null} />)).toBe('');
  });
});
