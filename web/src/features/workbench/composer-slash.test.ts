// input:  composer text, profile options and UI action handlers
// output: slash suggestion, resolution and local dispatch contracts
// pos:    Shared Web UI slash-command behavior tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { describe, expect, it, vi } from 'vitest';
import { SLASH_COMMANDS } from './chat-content';
import {
  buildSlashSuggestions,
  resolveSlashInput,
  runSlashAction,
  type SlashActionHandlers,
  type SlashProfileOption,
} from './composer-slash';

const profiles: SlashProfileOption[] = [
  { name: 'plan', detail: 'opus · claude', disabled: false },
  { name: 'execute', detail: 'sonnet · claude', disabled: false },
  { name: 'remote', detail: 'glm · pi', disabled: true },
];

describe('UI slash command model', () => {
  it('defines only the five UI-local shortcuts', () => {
    expect(SLASH_COMMANDS).toEqual([
      { cmd: '/new', desc: 'Start a new session' },
      { cmd: '/cancel', desc: 'Cancel the current run' },
      { cmd: '/compact', desc: 'Compact this session' },
      { cmd: '/profile', desc: 'Switch this session profile' },
      { cmd: '/settings', desc: 'Open settings' },
    ]);
  });

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
    expect(buildSlashSuggestions('/pro', profiles).map((item) => item.command)).toEqual(['/profile']);
    expect(buildSlashSuggestions('/profile ', profiles)).toEqual([
      { command: '/profile plan', description: 'opus · claude', action: { type: 'profile', profileName: 'plan' }, disabled: false },
      { command: '/profile execute', description: 'sonnet · claude', action: { type: 'profile', profileName: 'execute' }, disabled: false },
      { command: '/profile remote', description: 'glm · pi', action: { type: 'profile', profileName: 'remote' }, disabled: true },
    ]);
    expect(buildSlashSuggestions('/profile ex', profiles).map((item) => item.command)).toEqual(['/profile execute']);
  });

  it('marks unavailable actions disabled for menu and typed execution', () => {
    const availability = {
      newDisabled: true, cancelDisabled: true, compactDisabled: true, settingsDisabled: true,
    };
    const suggestions = buildSlashSuggestions('/', profiles, availability);
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
});
