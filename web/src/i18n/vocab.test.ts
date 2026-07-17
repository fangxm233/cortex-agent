import { describe, it, expect } from 'vitest';
import { en, zh } from './vocab';

describe('vocab en/zh parity', () => {
  it('en and zh expose the exact same key set', () => {
    const enKeys = Object.keys(en).sort();
    const zhKeys = Object.keys(zh).sort();
    expect(zhKeys).toEqual(enKeys);
  });

  it('has a non-trivial number of keys', () => {
    expect(Object.keys(en).length).toBeGreaterThanOrEqual(60);
  });

  it('every en value is a non-empty string', () => {
    for (const [k, v] of Object.entries(en)) {
      expect(typeof v, `en.${k}`).toBe('string');
      expect(v.length, `en.${k}`).toBeGreaterThan(0);
    }
  });

  it('every zh value is a non-empty string', () => {
    for (const [k, v] of Object.entries(zh)) {
      expect(typeof v, `zh.${k}`).toBe('string');
      expect(v.length, `zh.${k}`).toBeGreaterThan(0);
    }
  });

  it('carries the prototype dict() keys verbatim', () => {
    expect(en.newSession).toBe('New session');
    expect(zh.newSession).toBe('新会话');
    expect(en.composerPh).toBe('Message Cortex — type / for commands');
    expect(zh.tasks).toBe('任务');
  });

  it('carries the mobile bottom-tab labels (会话/线程/任务/机器)', () => {
    expect(en.sessions).toBe('Sessions');
    expect(zh.sessions).toBe('会话');
    expect(zh.threads).toBe('线程');
    expect(zh.machines).toBe('机器');
  });

  it('carries the status-pill labels', () => {
    expect(en.pillRunning).toBe('Running');
    expect(zh.pillRunning).toBe('运行中');
    expect(zh.pillWaiting).toBe('等待中');
    expect(zh.pillCancelled).toBe('已取消');
  });

  it('carries the 22a dual-zone left-rail labels', () => {
    expect(en.wbProjects).toBe('PROJECTS');
    expect(zh.wbProjects).toBe('项目');
    expect(en.wbSessions).toBe('SESSIONS');
    expect(zh.wbSessions).toBe('会话');
    expect(en.wbNewShort).toBe('New');
    expect(zh.wbNewShort).toBe('新建');
    expect(en.wbCost).toBe('Cost');
    expect(zh.wbCost).toBe('成本');
  });

  it('carries the mobile 5b thread-screen chrome keys (步骤/深度/待审批)', () => {
    expect(en.step).toBe('step');
    expect(zh.step).toBe('步骤');
    expect(en.depth).toBe('depth');
    expect(zh.depth).toBe('深度');
    expect(en.pendingApproval).toBe('Pending');
    expect(zh.pendingApproval).toBe('待审批');
  });
});
