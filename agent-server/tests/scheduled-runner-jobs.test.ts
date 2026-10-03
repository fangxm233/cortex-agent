import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('sync-public shell script operates on the checkout that contains it', () => {
  const repoRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-sync-path-'));
  const capturePath = path.join(root, 'git-cwds.txt');
  const gitPath = path.join(root, 'git');
  fs.writeFileSync(gitPath, `#!/bin/bash
printf '%s\\n' "$PWD" >> "$CAPTURE_PATH"
case "$*" in
  "rev-parse --verify "*) exit 1 ;;
  "rev-parse public/main") printf 'fixture-public-sha\\n' ;;
  "rev-parse --short "*) printf 'fixture-public-sha\\n' ;;
esac
`);
  fs.chmodSync(gitPath, 0o755);

  try {
    const result = spawnSync('bash', [path.join(repoRoot, 'scripts/sync-pull-from-public.sh')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH}`, CAPTURE_PATH: capturePath },
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const invokedFrom = fs.readFileSync(capturePath, 'utf8').trim().split('\n');
    assert.ok(invokedFrom.length > 0);
    assert.ok(invokedFrom.every(cwd => cwd === repoRoot));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
