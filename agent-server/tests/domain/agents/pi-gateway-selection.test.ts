import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { CONFIG_DIR } from '../../../src/core/paths.js';
import { retireProfiles } from '../../../src/store/retire-profiles-migration.js';
import { setDefaultModel } from '../../../src/domain/ui-service/mutate/models.js';
import { applyChannelSelection } from '../../../src/domain/agents/model-selection.js';
import type { EngineSelection } from '../../../src/domain/agents/engine-selection.js';

const selection: EngineSelection = {
  backend: 'pi', provider: 'anthropic', model: 'opus', thinking: 'high', connection: null,
};
/** The same pick in the profiles era, named by gateway mode. */
const legacySelection = { backend: 'pi', provider: 'anthropic', model: 'opus', thinking: 'high', mode: 'api' };
let home: string;
afterEach(async () => { if (home) await fs.rm(home, { recursive: true, force: true }); });

it.each(['api', undefined])('migrates explicit PI mode %s without confusing it with the provider', async mode => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'rp-pi-route-'));
  const config = path.join(home, 'config');
  await fs.mkdir(config);
  await fs.writeFile(path.join(config, 'profiles.json'), JSON.stringify({
    defaultProfile: 'pi', profiles: { pi: { ...legacySelection, mode } },
  }));
  await retireProfiles({ dataDir: home, storeDir: path.join(home, 'data') });
  const models = JSON.parse(await fs.readFile(path.join(config, 'models.json'), 'utf8'));
  // This step still writes its era's shape; the connections step after it drops a PI mode.
  expect(models.default).toEqual({ ...legacySelection, mode: mode ?? 'anthropic' });
});

it('a PI selection names no connection but its provider\'s accounts, in either selection writer', async () => {
  expect(await setDefaultModel(CONFIG_DIR, { selection })).toBe(true);
  await expect(setDefaultModel(CONFIG_DIR, { selection: { ...selection, connection: 'api' } }))
    .rejects.toMatchObject({ code: 'invalid-args' });
  const result = await applyChannelSelection({ channel: 'pi-api-route', ...selection, connection: 'api' });
  expect(result).toMatchObject({ ok: false, reason: 'invalid-connection' });
});
