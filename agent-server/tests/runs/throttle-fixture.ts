// input:  a temp CORTEX_HOME, a profiles.json fixture and the rate-limit throttle singleton
// output: loadThrottleHome() — an isolated throttle + profile world for attempt-policy tests
// pos:    Shared fixture for the run layer's attempt-policy suites (fallback, notices)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
//
// Rate-limit-throttle is a mutable module singleton. A suite must bind its private home BEFORE
// importing it, so every module in the suite sees the same instance; `_testReset()` between tests
// prevents leakage. Two suites need exactly this world, so it is built once here.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** A profile with a two-step fallback chain plus a single-attempt profile. */
export function writeProfilesFixture(home: string): void {
  const configDir = path.join(home, 'config');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, 'profiles.json'), JSON.stringify({
    defaultProfile: 'plan',
    profiles: {
      plan: {
        model: 'claude-sonnet-4-6', backend: 'claude', mode: 'plan',
        fallback: [
          { model: 'claude-sonnet-4-6', backend: 'claude', mode: 'api' },
          { model: 'claude-sonnet-4-6', backend: 'claude', mode: 'plan' },
        ],
      },
      scan: { model: 'claude-sonnet-4-6', backend: 'claude', mode: 'plan' },
    },
  }));
}

export interface ThrottleHome {
  rl: typeof import('../../src/domain/costs/rate-limit-throttle.js');
  profileRepo: typeof import('../../src/store/profile-repo.js').profileRepo;
  /** Arm the throttle so every listed mode reads as rate-limited for provider `anthropic`. */
  initThrottle(modes: string[]): Promise<typeof import('../../src/domain/costs/rate-limit-throttle.js')>;
  dispose(): void;
}

/**
 * Bind a private CORTEX_HOME, seed profiles, and load the throttle against it. Call at module
 * scope (top-level await) so the home is in place before any import that reads it.
 */
export async function loadThrottleHome(prefix: string): Promise<ThrottleHome> {
  const previousHome = process.env.CORTEX_HOME;
  const home = mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  process.env.CORTEX_HOME = home;

  const restoreHome = (): void => {
    if (previousHome === undefined) delete process.env.CORTEX_HOME;
    else process.env.CORTEX_HOME = previousHome;
  };

  try {
    writeProfilesFixture(home);
    const { setProcessLogPolicy } = await import('../../src/core/log.js');
    const restoreLogPolicy = setProcessLogPolicy({ consoleToStderr: false, files: false });
    try {
      const [testing, rl, profiles] = await Promise.all([
        import('../../src/platform/testing.js'),
        import('../../src/domain/costs/rate-limit-throttle.js'),
        import('../../src/store/profile-repo.js'),
      ]);
      return {
        rl,
        profileRepo: profiles.profileRepo,
        // handleRateLimitEvent only adds a mode on the extension path (resetsAt > current), so
        // each mode gets a slightly later resetsAt.
        async initThrottle(modes: string[]) {
          rl._testReset();
          await rl.initRateLimitThrottle(
            new testing.MockAdapter({ adminChannel: 'test-admin' }),
            { save: async () => {}, load: async () => null as never },
          );
          const baseReset = Math.floor(Date.now() / 1000) + 300;
          for (let i = 0; i < modes.length; i++) {
            await rl.handleRateLimitEvent(
              { rateLimitType: 'five_hour', utilization: 0.95, resetsAt: baseReset + i * 60 },
              { provider: 'anthropic', displayName: 'Anthropic', mode: modes[i] },
            );
          }
          return rl;
        },
        dispose() {
          try {
            rl._testReset();
            profiles.profileRepo.invalidate();
          } finally {
            restoreHome();
            rmSync(home, { recursive: true, force: true });
            restoreLogPolicy();
          }
        },
      };
    } catch (error) {
      restoreLogPolicy();
      throw error;
    }
  } catch (error) {
    restoreHome();
    rmSync(home, { recursive: true, force: true });
    throw error;
  }
}
