import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MNotificationToaster } from './MNotificationToaster';
import type { NotificationItem } from '@/features/notifications/notification-vm';

function item(over: Partial<NotificationItem>): NotificationItem {
  return {
    id: 'n1',
    level: 'info',
    title: '线程完成 — orchard-pipeline',
    meta: '评审通过 · 42m · 轻点查看产物',
    ts: '2026-07-15T12:00:00Z',
    sessionId: 's1',
    projectId: 'nimbus',
    ...over,
  };
}

describe('MNotificationToaster (1q)', () => {
  it('renders nothing when there are no items', () => {
    expect(renderToStaticMarkup(<MNotificationToaster items={[]} onDismiss={() => {}} onActivate={() => {}} />)).toBe('');
  });

  it('renders the cx avatar, title and meta of a banner', () => {
    const html = renderToStaticMarkup(
      <MNotificationToaster
        items={[item({})]}
        now={Date.parse('2026-07-15T12:00:00Z')}
        onDismiss={() => {}}
        onActivate={() => {}}
      />,
    );
    expect(html).toContain('aria-label="Cortex"');
    expect(html).toContain('线程完成 — orchard-pipeline');
    expect(html).toContain('评审通过 · 42m · 轻点查看产物');
    expect(html).toContain('现在');
  });
});
