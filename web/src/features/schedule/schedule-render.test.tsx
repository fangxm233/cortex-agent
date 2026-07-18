import { describe, it, expect } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup as renderRaw } from 'react-dom/server';
import { LangProvider } from '@/i18n';
// Components consume useVocab() → wrap every render in LangProvider (defaults to en vocab).
function renderToStaticMarkup(el: ReactElement): string {
  return renderRaw(createElement(LangProvider, null, el));
}
import { ScheduleModal } from './ScheduleModal';
import { defaultScheduleForm, type ScheduleForm } from './schedule-modal-vm';

function render(overrides: Partial<ScheduleForm> = {}, extra: Partial<Parameters<typeof ScheduleModal>[0]> = {}) {
  const form = { ...defaultScheduleForm('nimbus'), ...overrides };
  return renderToStaticMarkup(
    <ScheduleModal
      form={form}
      onChange={() => {}}
      onCancel={() => {}}
      onCreate={() => {}}
      valid
      pending={false}
      now={new Date(2026, 6, 7, 8, 8, 0)}
      profileOptions={['default', 'research']}
      {...extra}
    />,
  );
}

describe('ScheduleModal render (daily = proto-shot 13 bar)', () => {
  it('renders the 560px card + header + esc + Create schedule copy', () => {
    const html = render();
    expect(html).toContain('New schedule');
    expect(html).toContain('width:560px');
    expect(html).toContain('Create schedule');
    expect(html).toContain('>esc<');
  });

  it('renders the four TYPE segments with daily selected (var(--proto-accent)/var(--proto-accent-bg))', () => {
    const html = render();
    for (const t of ['interval', 'daily', 'weekly', 'once']) expect(html).toContain(`>${t}<`);
    expect(html).toContain('background:var(--proto-accent-bg)');
    expect(html).toContain('color:var(--proto-accent)');
  });

  it('daily shows TIME + PROFILE, not EVERY/IN/DAY', () => {
    const html = render({ type: 'daily' });
    expect(html).toContain('>TIME<');
    expect(html).toContain('>PROFILE<');
    expect(html).not.toContain('>EVERY<');
    expect(html).not.toContain('>DAY<');
  });

  it('PROFILE dropdown lists the provided (real) profile options', () => {
    const html = render({ type: 'daily', profile: 'research' }, { profileOptions: ['default', 'research'] });
    expect(html).toContain('>default</option>');
    expect(html).toContain('>research</option>');
  });

  it('renders MESSAGE / TARGET / FALLBACK section labels', () => {
    const html = render();
    expect(html).toContain('>MESSAGE<');
    expect(html).toContain('>TARGET<');
    expect(html).toContain('>FALLBACK<');
  });

  it('footer shows the computed next-run label with the blue clock', () => {
    const html = render({ type: 'daily', time: '09:00' });
    expect(html).toContain('next run ');
    expect(html).toContain('09:00');
    expect(html).toContain('· in 52m');
  });
});

describe('ScheduleModal TYPE → visible field', () => {
  it('interval shows EVERY, hides TIME', () => {
    const html = render({ type: 'interval' });
    expect(html).toContain('>EVERY<');
    expect(html).not.toContain('>TIME<');
  });
  it('weekly shows TIME + DAY + PROFILE', () => {
    const html = render({ type: 'weekly' });
    expect(html).toContain('>TIME<');
    expect(html).toContain('>DAY<');
    expect(html).toContain('>PROFILE<');
  });
  it('once shows IN, hides TIME', () => {
    const html = render({ type: 'once' });
    expect(html).toContain('>IN<');
    expect(html).not.toContain('>TIME<');
  });
});

describe('ScheduleModal Create affordance', () => {
  it('is dimmed + not-allowed when invalid', () => {
    const html = render({}, { valid: false });
    expect(html).toContain('cursor:not-allowed');
    expect(html).toContain('opacity:0.55');
  });
});
