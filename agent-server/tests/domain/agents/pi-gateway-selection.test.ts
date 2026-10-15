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
  backend: 'pi', provider: 'anthropic', model: 'opus', thinking: 'high', mode: 'api',
};
const readGateway = () => ({ top: {}, endpoints: { anthropic: { api: {}, anthropic: {} } } });
let home: string;
afterEach(async () => { if (home) await fs.rm(home, { recursive: true, force: true }); });

it.each(['api', undefined])('migrates explicit PI mode %s without confusing it with the provider', async mode => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'rp-pi-route-'));
  const config = path.join(home, 'config');
  await fs.mkdir(config);
  await fs.writeFile(path.join(config, 'profiles.json'), JSON.stringify({
    defaultProfile: 'pi', profiles: { pi: { ...selection, mode } },
  }));
  await retireProfiles({ dataDir: home, storeDir: path.join(home, 'data') });
  const models = JSON.parse(await fs.readFile(path.join(config, 'models.json'), 'utf8'));
  expect(models.default).toEqual({ ...selection, mode: mode ?? 'anthropic' });
});

it('accepts a declared PI gateway route independent of provider in both selection writers', async () => {
  expect(await setDefaultModel(CONFIG_DIR, { selection }, readGateway)).toBe(true);
  const result = await applyChannelSelection({ channel: 'pi-api-route', ...selection, readGateway });
  expect(result).toMatchObject({ ...selection, ok: true });
});
