import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HooksOverview } from '@cortex-agent/ui-contract';
import type { SettingsQuery } from '@/features/settings/controllers/useConfigSnapshot';

const h = vi.hoisted(() => ({ query: null as unknown as SettingsQuery<HooksOverview> }));

vi.mock('@/features/settings/controllers/useHooksController', () => ({ useHooksOverview: () => h.query }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/i18n', async () => {
  const { en } = await import('@/i18n/vocab');
  return { useVocab: () => en, useVocabOptional: () => en };
});

import { en } from '@/i18n/vocab';
import { MHooksScreen } from './MHooksScreen';

function text(): string {
  let renderer!: ReactTestRenderer;
  act(() => { renderer = create(<MHooksScreen />); });
  return JSON.stringify(renderer.toJSON());
}

const idle = { data: undefined, isLoading: false, isError: false, error: null };

beforeEach(() => { h.query = idle; });

describe('mobile Hooks load states', () => {
  it('reports a failed load instead of an empty hook list', () => {
    h.query = { ...idle, isError: true, error: { message: 'hooks dir unreadable' } };
    const out = text();
    expect(out).toContain(en.hkLoadFailed);
    expect(out).toContain('hooks dir unreadable');
    expect(out).not.toContain(en.hookEmpty);
  });

  it('shows loading copy rather than the page title while the list loads', () => {
    h.query = { ...idle, isLoading: true };
    const out = text();
    expect(out).toContain(en.hkLoading);
    expect(out).not.toContain(en.hookEmpty);
  });

  it('shows the empty state only for a loaded, empty list', () => {
    h.query = { ...idle, data: { hooks: [], scripts: [], hooksDir: '/h' } };
    const out = text();
    expect(out).toContain(en.hookEmpty);
    expect(out).toContain(en.hookEnabledWord);
  });
});
