import { expect, test, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ read: vi.fn(), defaults: vi.fn() }));
vi.mock('../../../src/store/models-repo.js', () => ({ modelsRepo: { readIfPresent: mocks.read } }));
vi.mock('../../../src/domain/agents/models.js', () => ({ getDefaultSelection: mocks.defaults }));
import { resolveConfiguredDefaultRun } from '../../../src/domain/runs/config-resolver.js';

test('a models file without a default is still unconfigured', () => {
  mocks.read.mockReturnValue({ favorites: [] });
  expect(resolveConfiguredDefaultRun()).toBeNull();
  expect(mocks.defaults).not.toHaveBeenCalled();
});
