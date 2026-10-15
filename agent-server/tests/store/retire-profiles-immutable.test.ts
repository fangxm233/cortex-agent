import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { runMigrations } from '../../src/store/version-migrations.js';

let home: string;
afterEach(async () => {
  vi.unstubAllEnvs();
  if (home) await fs.rm(home, { recursive: true, force: true });
});

it('retries S10 on a mutable boot after immutable legacy configuration was skipped', async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'rp-immutable-retry-'));
  const config = path.join(home, 'config');
  const storeDir = path.join(home, 'data');
  await fs.mkdir(config);
  await fs.mkdir(storeDir);
  const profiles = JSON.stringify({ defaultProfile: 'plan', profiles: {
    plan: { backend: 'claude', model: 'opus', thinking: 'high', mode: 'plan' },
  } });
  await fs.writeFile(path.join(config, 'profiles.json'), profiles);
  const options = { dataDir: home, storeDir, defaultsDir: path.join(home, 'defaults') };
  vi.stubEnv('CORTEX_CONFIG_IMMUTABLE', '1');
  await runMigrations(options);
  const versions = () => fs.readFile(path.join(storeDir, 'versions.json'), 'utf8').then(JSON.parse);
  expect(await versions()).not.toHaveProperty('sentinel:retire-profiles');
  expect(await fs.readFile(path.join(config, 'profiles.json'), 'utf8')).toBe(profiles);
  vi.stubEnv('CORTEX_CONFIG_IMMUTABLE', '0');
  await runMigrations(options);
  expect((await versions())['sentinel:retire-profiles']).toBe('2026.10.15');
  expect(JSON.parse(await fs.readFile(path.join(config, 'models.json'), 'utf8')).default.model).toBe('opus');
  await expect(fs.stat(path.join(config, 'profiles.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
