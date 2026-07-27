// input:  active/null rate-limit view models and desktop/mobile status components
// output: active-only trigger, details, and mobile sheet render assertions
// pos:    Presentational regression tests for provider rate-limit status
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildRateLimitView } from './rate-limit-vm';
import {
  DesktopRateLimitStatus,
  MobileRateLimitSheet,
  MobileRateLimitStatus,
  RateLimitDetails,
} from './RateLimitStatus';

const now = 1_800_000_000;
const status = buildRateLimitView({
  providers: [
    {
      provider: 'anthropic', displayName: 'Anthropic',
      windows: [{ type: 'seven_day', utilization: 0.97, resetsAt: now + 3600, activatedAt: 1 }],
    },
    {
      provider: 'openai-codex', displayName: 'OpenAI',
      windows: [{ type: 'five_hour', utilization: 0.94, resetsAt: now + 2520, activatedAt: 2 }],
    },
  ],
}, now, 'en')!;

describe('rate-limit status presentation', () => {
  it('renders nothing on desktop and mobile when there is no active status', () => {
    expect(renderToStaticMarkup(<DesktopRateLimitStatus status={null} />)).toBe('');
    expect(renderToStaticMarkup(<MobileRateLimitStatus status={null} onOpen={vi.fn()} />)).toBe('');
  });

  it('renders one amber desktop trigger with aggregate copy', () => {
    const html = renderToStaticMarkup(<DesktopRateLimitStatus status={status} />);
    expect(html).toContain('2 providers limited · first 42m');
    expect(html).toContain('aria-label="Rate limit status"');
    expect(html).toContain('var(--pill-waiting-fg)');
  });

  it('renders provider/window details with independent countdowns', () => {
    const html = renderToStaticMarkup(<RateLimitDetails status={status} />);
    expect(html).toContain('Anthropic');
    expect(html).toContain('OpenAI');
    expect(html).toContain('7d');
    expect(html).toContain('1h');
    expect(html).toContain('5h');
    expect(html).toContain('42m');
  });

  it('renders the compact mobile trigger and bottom-sheet details', () => {
    const trigger = renderToStaticMarkup(<MobileRateLimitStatus status={status} onOpen={vi.fn()} />);
    expect(trigger).toContain('2 providers limited · first 42m');
    expect(trigger).toContain('aria-label="Rate limit status"');

    const sheet = renderToStaticMarkup(<MobileRateLimitSheet status={status} onClose={vi.fn()} />);
    expect(sheet).toContain('Rate limits');
    expect(sheet).toContain('Anthropic');
    expect(sheet).toContain('OpenAI');
  });
});
