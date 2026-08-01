// input:  core path constants and Node os paths
// output: one JSON line with module-load paths and environment keys
// pos:    Spawned proof fixture for the pinned Node launcher
// >>> If I am updated, update my header and folder CORTEX.md <<<

import os from 'node:os';
import {
  CONFIG_DIR,
  DATA_DIR,
  PROJECTS_DIR,
  STORE_DIR,
  WORKSPACE_DIR,
} from '../../../src/core/paths.js';

process.stdout.write(`${JSON.stringify({
  dataDir: DATA_DIR,
  configDir: CONFIG_DIR,
  storeDir: STORE_DIR,
  projectsDir: PROJECTS_DIR,
  workspaceDir: WORKSPACE_DIR,
  homeDir: os.homedir(),
  tempDir: os.tmpdir(),
  envKeys: Object.keys(process.env).sort(),
  forbiddenValue: process.env.SLACK_BOT_TOKEN ?? null,
  nodeSentinel: process.env.NODE_PIN_TEST ?? null,
})}\n`);
