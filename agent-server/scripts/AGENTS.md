# Server scripts

- `bundle.mjs`: opt-in ESM package staging; `bundle-smoke*.mjs` and `bundle-measure.mjs`: installed-package verification and measurements.
- `sea-build.mjs`: opt-in single-executable builder; `sea-launcher.cjs`, `sea-runtime.cjs`, `sea-cache.cjs`: extraction and multi-call dispatch; `sea-*.test.cjs`: cache/preload tests.
- `sea-preload.cjs`: Node-compatible preload option parsing; `sea-smoke*.mjs`: isolated SEA integration checks; `sea-measure.mjs`: process-cold startup and RSS comparison.
- Other scripts implement the package build, asset copying, dependency vendoring, postinstall, and scoped test runners; see `../package.json` for lifecycle commands.
