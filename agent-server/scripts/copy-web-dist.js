// Prepack step: stage the built Web UI SPA inside the package so it ships in `files: ["web/dist/"]`.
// The SPA is built by the @cortex-agent/web workspace package to <repo-root>/web/dist; npm `files`
// can only include paths under the package root, so we copy it to agent-server/web/dist before pack.
// Runs on `npm pack` / `npm publish` (prepack) — NOT on a plain `npm run build`, to avoid coupling
// the per-package build to the web build (in `pnpm -r` order agent-server builds before web).
//
// Requires a prior full workspace build (`pnpm -w build`) so <repo-root>/web/dist exists. When it
// does not, this fails loudly rather than publishing a package with a missing SPA.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(scriptDir, '..'); // agent-server/
const repoRoot = path.resolve(pkgRoot, '..'); // Cortex/
const srcDir = path.join(repoRoot, 'web', 'dist');
const destDir = path.join(pkgRoot, 'web', 'dist');

if (!fs.existsSync(srcDir)) {
  console.error(
    `[copy-web-dist] source SPA not found: ${srcDir}\n` +
      `Run a full workspace build first (pnpm -w build) so the Web UI is built before packing.`,
  );
  process.exit(1);
}

fs.rmSync(destDir, { recursive: true, force: true });
fs.mkdirSync(path.dirname(destDir), { recursive: true });
// Source maps stay in <repo-root>/web/dist (the release workflow archives them from there); the
// package and the OTA bundle it serves don't need them.
fs.cpSync(srcDir, destDir, { recursive: true, filter: (src) => !src.endsWith('.map') });
console.log(`[copy-web-dist] staged SPA: ${srcDir} -> ${destDir}`);
