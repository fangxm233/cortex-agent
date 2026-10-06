// The onboarding copy names the Node floor the shell's setup probe enforces: the server package's
// engines.node, which desktop/src-tauri/src/setup.rs reads at build time.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { onboardingEn, onboardingZh } from './onboarding-vocab';

const serverPackage = path.resolve(import.meta.dirname, '../../../agent-server/package.json');

it('names the server engines.node floor in the onboarding copy', () => {
  const range: string = JSON.parse(readFileSync(serverPackage, 'utf8')).engines.node;
  const floor = /^>=(\d+(?:\.\d+)*)$/.exec(range)?.[1];
  expect(floor, range).toBeDefined();
  const shown = floor!.replace(/(\.0)+$/, '');
  const named = new RegExp(`Node\\.js ${shown.replaceAll('.', '\\.')}(?![\\d.])`);
  for (const vocab of [onboardingEn, onboardingZh]) {
    expect(vocab.onbFactNode).toMatch(named);
    expect(vocab.onbErrNodeRequired).toMatch(named);
  }
});
