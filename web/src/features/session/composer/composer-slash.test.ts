import { describe, expect, it, vi } from 'vitest';
import { en, zh } from '@/i18n';
import {
  buildSlashSuggestions,
  resolveSlashInput,
  runSlashAction,
  type SlashActionHandlers,
  type SlashProfileOption,
  type SlashSkillOption,
} from './composer-slash';

const profiles: SlashProfileOption[] = [
  { name: 'plan', detail: 'opus · claude', disabled: false },
  { name: 'execute', detail: 'sonnet · claude', disabled: false },
  { name: 'remote', detail: 'glm · pi', disabled: true },
];

describe('UI slash command model', () => {
  it('resolves exact local actions and rejects extra arguments', () => {
    expect(resolveSlashInput('/new', profiles)).toEqual({ kind: 'action', action: { type: 'new' } });
    expect(resolveSlashInput('/cancel', profiles)).toEqual({ kind: 'action', action: { type: 'cancel' } });
    expect(resolveSlashInput('/compact', profiles)).toEqual({ kind: 'action', action: { type: 'compact' } });
    expect(resolveSlashInput('/settings', profiles)).toEqual({ kind: 'action', action: { type: 'settings' } });
    expect(resolveSlashInput('/new later', profiles)).toEqual({ kind: 'invalid' });
  });

  it('requires a configured profile and returns its canonical name', () => {
    expect(resolveSlashInput('/profile', profiles)).toEqual({ kind: 'incomplete' });
    expect(resolveSlashInput('/profile EXECUTE', profiles)).toEqual({
      kind: 'action', action: { type: 'profile', profileName: 'execute' },
    });
    expect(resolveSlashInput('/profile remote', profiles)).toEqual({ kind: 'disabled' });
    expect(resolveSlashInput('/profile missing', profiles)).toEqual({ kind: 'invalid' });
    expect(resolveSlashInput('/profile execute later', profiles)).toEqual({ kind: 'invalid' });
  });

  it('leaves ordinary text outside the local path but consumes unknown slash text', () => {
    expect(resolveSlashInput('hello', profiles)).toEqual({ kind: 'none' });
    expect(resolveSlashInput('/', profiles)).toEqual({ kind: 'incomplete' });
    expect(resolveSlashInput('/ne', profiles)).toEqual({ kind: 'incomplete' });
    expect(resolveSlashInput('/status', profiles)).toEqual({ kind: 'invalid' });
  });

  it('expands profile arguments into filtered configured-profile suggestions', () => {
    expect(buildSlashSuggestions('/pro', profiles, en).map((item) => item.command)).toEqual(['/profile']);
    expect(buildSlashSuggestions('/profile ', profiles, en)).toEqual([
      { command: '/profile plan', description: 'opus · claude', action: { type: 'profile', profileName: 'plan' }, disabled: false },
      { command: '/profile execute', description: 'sonnet · claude', action: { type: 'profile', profileName: 'execute' }, disabled: false },
      { command: '/profile remote', description: 'glm · pi', action: { type: 'profile', profileName: 'remote' }, disabled: true },
    ]);
    expect(buildSlashSuggestions('/profile ex', profiles, en).map((item) => item.command)).toEqual(['/profile execute']);
    expect(buildSlashSuggestions('/new', profiles, zh)[0].description).toBe('开始新会话');
  });

  it('marks unavailable actions disabled for menu and typed execution', () => {
    const availability = {
      newDisabled: true, cancelDisabled: true, compactDisabled: true, settingsDisabled: true,
    };
    const suggestions = buildSlashSuggestions('/', profiles, en, availability);
    expect(suggestions.find((item) => item.command === '/new')?.disabled).toBe(true);
    expect(suggestions.find((item) => item.command === '/cancel')?.disabled).toBe(true);
    expect(suggestions.find((item) => item.command === '/compact')?.disabled).toBe(true);
    expect(suggestions.find((item) => item.command === '/settings')?.disabled).toBe(true);
    expect(resolveSlashInput('/cancel', profiles, availability)).toEqual({ kind: 'disabled' });
  });

  it('dispatches only through injected UI handlers', () => {
    const handlers: SlashActionHandlers = {
      onNew: vi.fn(), onCancel: vi.fn(), onCompact: vi.fn(), onProfile: vi.fn(), onSettings: vi.fn(),
    };
    runSlashAction({ type: 'profile', profileName: 'execute' }, handlers);
    runSlashAction({ type: 'settings' }, handlers);
    expect(handlers.onProfile).toHaveBeenCalledWith('execute');
    expect(handlers.onSettings).toHaveBeenCalledOnce();
    expect(handlers.onNew).not.toHaveBeenCalled();
  });

  it('offers the conversation skills after local commands and sends their invocation as typed', () => {
    const skills: SlashSkillOption[] = [
      { name: 'develop', command: 'cortex-coder:develop', description: 'Implement a change' },
      { name: 'paper-draft', command: 'cortex-writer:paper-draft', description: 'Draft prose' },
    ];
    expect(buildSlashSuggestions('/', profiles, en, {}, skills).map((item) => item.command)).toEqual([
      '/new', '/cancel', '/compact', '/profile', '/settings', '/cortex-coder:develop', '/cortex-writer:paper-draft',
    ]);
    expect(buildSlashSuggestions('/dev', profiles, en, {}, skills)).toEqual([
      { command: '/cortex-coder:develop', description: 'Implement a change', action: null, disabled: false, skill: true },
    ]);
    expect(buildSlashSuggestions('/cortex-w', profiles, en, {}, skills).map((item) => item.command))
      .toEqual(['/cortex-writer:paper-draft']);
    expect(resolveSlashInput('/cortex-coder:develop fix the rail', profiles, {}, skills)).toEqual({ kind: 'none' });
    expect(resolveSlashInput('/develop', profiles, {}, skills)).toEqual({ kind: 'none' });
    expect(resolveSlashInput('/dev', profiles, {}, skills)).toEqual({ kind: 'incomplete' });
    expect(resolveSlashInput('/status', profiles, {}, skills)).toEqual({ kind: 'invalid' });
  });
});
