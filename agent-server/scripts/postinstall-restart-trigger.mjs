// Runs after `npm install` (including `npm install -g <tgz>` upgrades). Touches
// $CORTEX_HOME/data/.restart so any running `cortex daemon` picks up the new
// dist/ and respawns its app.js child. Silently does nothing if CORTEX_HOME
// isn't initialized yet (fresh installs — daemon hasn't been started).
//
// We don't fail the install on any error: this is best-effort hot-reload.
//
// Touching the trigger from a dev checkout or worktree install is harmless: the
// daemon queues the restart until app.ts reports idle, so live turns are not cut.

import { existsSync, writeFileSync, utimesSync } from 'fs';
import * as path from 'path';
import * as os from 'os';

function main() {
  // npm runs install scripts with CWD set to the package dir. Don't rely on
  // anything in the package — only on env / homedir.
  const dataDir = process.env.CORTEX_HOME
    ? path.resolve(process.env.CORTEX_HOME)
    : path.join(os.homedir(), '.cortex');
  const storeDir = path.join(dataDir, 'data');
  const trigger = path.join(storeDir, '.restart');

  // If the user hasn't initialized CORTEX_HOME yet (no data/ dir), there's no
  // daemon to nudge. Skip — `cortex init` + `cortex daemon` are the next steps.
  if (!existsSync(storeDir)) return;

  try {
    if (existsSync(trigger)) {
      const now = new Date();
      utimesSync(trigger, now, now);
    } else {
      writeFileSync(trigger, '');
    }
    console.log(`[cortex] Wrote restart trigger: ${trigger}`);
  } catch (err) {
    // Permission denied / read-only filesystem / etc. Don't fail the install.
    console.warn(`[cortex] Could not touch ${trigger}: ${err.message}`);
  }
}

main();
