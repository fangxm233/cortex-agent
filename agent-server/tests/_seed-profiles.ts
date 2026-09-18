// The minimal profile set scripts/seed-test-config.sh writes into the shared home of a
// run-tests.sh run. A scoped run (`vitest run <file>`) starts from an empty skeleton home, so a
// file whose code path resolves a profile (resolveProfileConfig / resolveRunConfig /
// registerThreadSession) seeds the same set itself — import this AFTER `_test-home.js`.
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { CONFIG_DIR } from '../src/core/utils.js';
import { profileRepo } from '../src/store/profile-repo.js';

/** `plan`/`scan`/`qa` share backend claude; `execute` is pi — pins the cross-backend paths. */
export const TEST_PROFILES = {
  defaultProfile: 'plan',
  profiles: {
    plan: { model: 'claude-sonnet-4-6', backend: 'claude', mode: 'plan' },
    execute: { model: 'claude-sonnet-4-6', backend: 'pi', provider: 'anthropic', mode: 'plan' },
    scan: { model: 'claude-sonnet-4-6', backend: 'claude', mode: 'plan' },
    qa: { model: 'claude-sonnet-4-6', backend: 'claude', mode: 'plan' },
  },
};

export function seedTestProfiles(): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(path.join(CONFIG_DIR, 'profiles.json'), JSON.stringify(TEST_PROFILES));
  profileRepo.invalidate();
}
