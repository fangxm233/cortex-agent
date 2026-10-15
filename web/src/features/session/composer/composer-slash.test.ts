import { describe, expect, it, vi } from 'vitest';
import { en, zh } from '@/i18n';
import {
  buildSlashSuggestions,
  resolveSlashInput,
  runSlashAction,
  type SlashActionHandlers,
  type SlashModelOption,
  type SlashSkillOption,
} from './composer-slash';

const models: SlashModelOption[] = [
  { name: 'plan', detail: 'opus · claude', disabled: false },
  { name: 'execute', detail: 'sonnet · claude', disabled: false },
  { name: 'remote', detail: 'glm · pi', disabled: true },
];

describe('UI slash command model', () => {
  it('resolves exact local actions and rejects extra arguments', () => {
    expect(resolveSlashInput('/new', models)).toEqual({ kind: 'action', action: { type: 'new' } });
    expect(resolveSlashInput('/cancel', models)).toEqual({ kind: 'action', action: { type: 'cancel' } });
    expect(resolveSlashInput('/compact', models)).toEqual({ kind: 'action', action: { type: 'compact' } });
    expect(resolveSlashInput('/settings', models)).toEqual({ kind: 'action', action: { type: 'settings' } });
    expect(resolveSlashInput('/usage', models)).toEqual({ kind: 'action', action: { type: 'usage' } });
    expect(resolveSlashInput('/new later', models)).toEqual({ kind: 'invalid' });
  });

  it('requires a configured model and returns its canonical name', () => {
    expect(resolveSlashInput('/model', models)).toEqual({ kind: 'incomplete' });
    expect(resolveSlashInput('/model EXECUTE', models)).toEqual({
      kind: 'action', action: { type: 'model', modelName: 'execute' },
    });
    expect(resolveSlashInput('/model remote', models)).toEqual({ kind: 'disabled' });
    expect(resolveSlashInput('/model missing', models)).toEqual({ kind: 'invalid' });
    expect(resolveSlashInput('/model execute later', models)).toEqual({ kind: 'invalid' });
  });

  it('leaves ordinary text outside the local path but consumes unknown slash text', () => {
    expect(resolveSlashInput('hello', models)).toEqual({ kind: 'none' });
    expect(resolveSlashInput('/', models)).toEqual({ kind: 'incomplete' });
    expect(resolveSlashInput('/ne', models)).toEqual({ kind: 'incomplete' });
    expect(resolveSlashInput('/status', models)).toEqual({ kind: 'invalid' });
  });

  it('expands model arguments into filtered configured-model suggestions', () => {
    expect(buildSlashSuggestions('/mod', models, en).map((item) => item.command)).toEqual(['/model']);
    expect(buildSlashSuggestions('/model ', models, en)).toEqual([
      { command: '/model plan', description: 'opus · claude', action: { type: 'model', modelName: 'plan' }, disabled: false },
      { command: '/model execute', description: 'sonnet · claude', action: { type: 'model', modelName: 'execute' }, disabled: false },
      { command: '/model remote', description: 'glm · pi', action: { type: 'model', modelName: 'remote' }, disabled: true },
    ]);
    expect(buildSlashSuggestions('/model ex', models, en).map((item) => item.command)).toEqual(['/model execute']);
    expect(buildSlashSuggestions('/new', models, zh)[0].description).toBe('开始新会话');
  });

  it('marks unavailable actions disabled for menu and typed execution', () => {
    const availability = {
      newDisabled: true, cancelDisabled: true, compactDisabled: true, settingsDisabled: true, usageDisabled: true,
    };
    const suggestions = buildSlashSuggestions('/', models, en, availability);
    expect(suggestions.find((item) => item.command === '/new')?.disabled).toBe(true);
    expect(suggestions.find((item) => item.command === '/cancel')?.disabled).toBe(true);
    expect(suggestions.find((item) => item.command === '/compact')?.disabled).toBe(true);
    expect(suggestions.find((item) => item.command === '/settings')?.disabled).toBe(true);
    expect(suggestions.find((item) => item.command === '/usage')?.disabled).toBe(true);
    expect(resolveSlashInput('/cancel', models, availability)).toEqual({ kind: 'disabled' });
  });

  it('dispatches only through injected UI handlers', () => {
    const handlers: SlashActionHandlers = {
      onNew: vi.fn(), onCancel: vi.fn(), onCompact: vi.fn(), onModel: vi.fn(), onSettings: vi.fn(), onUsage: vi.fn(),
    };
    runSlashAction({ type: 'model', modelName: 'execute' }, handlers);
    runSlashAction({ type: 'settings' }, handlers);
    runSlashAction({ type: 'usage' }, handlers);
    expect(handlers.onModel).toHaveBeenCalledWith('execute');
    expect(handlers.onSettings).toHaveBeenCalledOnce();
    expect(handlers.onUsage).toHaveBeenCalledOnce();
    expect(handlers.onNew).not.toHaveBeenCalled();
  });

  it('offers the conversation skills after local commands and sends their invocation as typed', () => {
    const skills: SlashSkillOption[] = [
      { name: 'develop', command: 'cortex-coder:develop', description: 'Implement a change' },
      { name: 'paper-draft', command: 'cortex-writer:paper-draft', description: 'Draft prose' },
    ];
    expect(buildSlashSuggestions('/', models, en, {}, skills).map((item) => item.command)).toEqual([
      '/new', '/cancel', '/compact', '/model', '/settings', '/usage', '/cortex-coder:develop', '/cortex-writer:paper-draft',
    ]);
    expect(buildSlashSuggestions('/dev', models, en, {}, skills)).toEqual([
      { command: '/cortex-coder:develop', description: 'Implement a change', action: null, disabled: false, skill: true },
    ]);
    expect(buildSlashSuggestions('/cortex-w', models, en, {}, skills).map((item) => item.command))
      .toEqual(['/cortex-writer:paper-draft']);
    expect(resolveSlashInput('/cortex-coder:develop fix the rail', models, {}, skills)).toEqual({ kind: 'none' });
    expect(resolveSlashInput('/develop', models, {}, skills)).toEqual({ kind: 'none' });
    expect(resolveSlashInput('/dev', models, {}, skills)).toEqual({ kind: 'incomplete' });
    expect(resolveSlashInput('/status', models, {}, skills)).toEqual({ kind: 'invalid' });
  });
});
