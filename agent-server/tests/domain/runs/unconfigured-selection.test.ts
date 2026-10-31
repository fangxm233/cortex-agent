import { expect, test, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ read: vi.fn(), readSync: vi.fn() }));
vi.mock('../../../src/store/models-repo.js', () => ({ modelsRepo: { readIfPresent: mocks.read, readSync: mocks.readSync } }));
import { resolveConfiguredDefaultRun } from '../../../src/domain/runs/config-resolver.js';

test('a models file without a default is still unconfigured', () => {
  mocks.read.mockReturnValue({ favorites: [] });
  expect(resolveConfiguredDefaultRun()).toBeNull();
  expect(mocks.readSync).not.toHaveBeenCalled();
});
