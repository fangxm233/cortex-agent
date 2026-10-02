import { describe, expect, it } from 'vitest';
import { sessionDisplayTitle } from './session-display-title';

describe('sessionDisplayTitle', () => {
  const session = { name: 'session-a', label: 'Automatic task title' };

  it('preserves numbered scheduled titles for automatic and legacy labels', () => {
    expect(sessionDisplayTitle(session, 'Task · run #2')).toBe('Task · run #2');
    expect(sessionDisplayTitle({ ...session, labelRenamed: false }, '任务 · 第 2 次运行'))
      .toBe('任务 · 第 2 次运行');
  });

  it('prefers a manually renamed label over the generated run title', () => {
    expect(sessionDisplayTitle({ ...session, label: 'My result', labelRenamed: true }, 'Task · run #2'))
      .toBe('My result');
  });

  it('uses the label or identity when a scheduled title does not apply', () => {
    expect(sessionDisplayTitle(session, null)).toBe(session.label);
    expect(sessionDisplayTitle({ ...session, label: null }, null)).toBe(session.name);
  });
});
