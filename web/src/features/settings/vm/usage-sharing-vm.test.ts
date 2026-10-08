import { describe, expect, it, vi } from 'vitest';
import type { UsageSharingSettings } from '@cortex-agent/ui-contract';
import { UsageSharingController, usageSharingIssues } from './usage-sharing-vm';

const OFF: UsageSharingSettings = { enabled: false, name: '', org: '', email: '' };
const ON: UsageSharingSettings = { enabled: true, name: 'Ada', org: 'Lab', email: 'ada@example.com' };

async function loaded(stored: UsageSharingSettings = OFF) {
  const set = vi.fn(async (input: UsageSharingSettings) => input);
  const controller = new UsageSharingController({ get: vi.fn().mockResolvedValue(stored), set });
  await controller.load();
  return { controller, set };
}

describe('usageSharingIssues', () => {
  it('requires a name and a valid email only while enabled', () => {
    expect(usageSharingIssues(OFF)).toEqual([]);
    expect(usageSharingIssues(ON)).toEqual([]);
    expect(usageSharingIssues({ ...ON, name: ' ', email: 'ada' })).toEqual(['name-required', 'email-invalid']);
    expect(usageSharingIssues({ ...ON, org: '' })).toEqual([]);
  });
});

describe('UsageSharingController', () => {
  it('loads the stored choice as the draft', async () => {
    const { controller } = await loaded(ON);
    expect(controller.state.saved).toEqual(ON);
    expect(controller.state.draft).toEqual(ON);
    expect(controller.dirty()).toBe(false);
  });

  it('keeps a load failure without a stored choice', async () => {
    const controller = new UsageSharingController({ get: vi.fn().mockRejectedValue(new Error('offline')), set: vi.fn() });
    await controller.load();
    expect(controller.state.saved).toBeNull();
    expect(controller.state.loadError).toBe('offline');
    expect(controller.dirty()).toBe(false);
  });

  it('toggling marks the draft dirty and toggling back clears it', async () => {
    const { controller } = await loaded();
    controller.setEnabled(true);
    expect(controller.dirty()).toBe(true);
    controller.setEnabled(false);
    expect(controller.dirty()).toBe(false);
  });

  it('shows validation only after a save attempt and does not call the server', async () => {
    const { controller, set } = await loaded();
    controller.setEnabled(true);
    expect(controller.issues()).toEqual([]);

    await controller.save();

    expect(set).not.toHaveBeenCalled();
    expect(controller.issues()).toEqual(['name-required', 'email-invalid']);
    controller.setField('name', 'Ada');
    expect(controller.issues()).toEqual(['email-invalid']);
  });

  it('saves a trimmed identity and reports success until the next edit', async () => {
    const { controller, set } = await loaded();
    controller.setEnabled(true);
    controller.setField('name', ' Ada ');
    controller.setField('email', 'ada@example.com ');

    await controller.save();

    expect(set).toHaveBeenCalledWith({ enabled: true, name: 'Ada', org: '', email: 'ada@example.com' });
    expect(controller.state.justSaved).toBe(true);
    expect(controller.dirty()).toBe(false);
    controller.setField('org', 'Lab');
    expect(controller.state.justSaved).toBe(false);
    expect(controller.dirty()).toBe(true);
  });

  it('turning sharing off is a change on its own and keeps the stored identity in the draft', async () => {
    const { controller, set } = await loaded(ON);
    set.mockResolvedValue({ ...ON, enabled: false });
    controller.setEnabled(false);

    await controller.save();

    expect(set).toHaveBeenCalledWith({ ...ON, enabled: false });
    expect(controller.state.draft).toEqual({ ...ON, enabled: false });
  });

  it('keeps the draft and reports the error when saving fails', async () => {
    const { controller, set } = await loaded();
    set.mockRejectedValue(new Error('write failed'));
    controller.setEnabled(true);
    controller.setField('name', 'Ada');
    controller.setField('email', 'ada@example.com');

    await controller.save();

    expect(controller.state.saveError).toBe('write failed');
    expect(controller.state.saving).toBe(false);
    expect(controller.dirty()).toBe(true);
  });
});
