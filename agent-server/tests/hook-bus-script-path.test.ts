// input:  HookBus registry entries and real shared hook runner
// output: spaced registry script path execution regression
// pos:    Verifies HookBus executes script paths as one argument
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, test } from 'vitest';
import { emitCortexEvent, initHookBus } from '../src/core/hook-bus.js';
import type { HookEntry } from '../src/store/hook-registry.js';

const hooksDir = mkdtempSync(path.join(os.tmpdir(), 'hook bus scripts-'));

afterAll(() => {
  rmSync(hooksDir, { recursive: true, force: true });
});

test('executes a registry script from a hooks directory containing spaces', async () => {
  writeFileSync(
    path.join(hooksDir, 'spaced-script.mjs'),
    "process.stdout.write('spaced hook ran');\n",
  );
  const hook: HookEntry = {
    id: 'spaced-script',
    event: 'cortex:thread.end',
    run: { script: 'spaced-script.mjs' },
    result: 'stdout-as-prompt',
  };
  initHookBus({ entries: [hook], hooksDir });

  const results = await emitCortexEvent('cortex:thread.end', {});

  assert.deepEqual(results, [{ id: 'spaced-script', result: 'spaced hook ran' }]);
});
