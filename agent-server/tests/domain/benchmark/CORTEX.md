Please update me when files in this folder change

Production benchmark evidence regression tests, mirroring `src/domain/benchmark/`.

| filename | role | function |
|---|---|---|
| accounting-reconciliation.test.ts | test | Verifies usage accounting records |
| attempt-record.test.ts | test | Verifies attempts and durable edges |
| composite-manifest.test.ts | test | Verifies composite evidence publication |
| identity.test.ts | test | Verifies identity hashes |
| production-accounting-attribution.test.ts | test | Verifies concurrent usage attribution |
| production-attempt-identity.test.ts | test | Verifies spawn identity persistence |
| production-attempt-journal.test.ts | test | Verifies attempt journal persistence |
| production-benchmark-evidence-context.test.ts | test | Verifies evidence context inheritance |
| production-evidence-boundary-fixture.ts | fixture | Builds production evidence scenarios |
| production-evidence-export.test.ts | test | Verifies production evidence export |
| role-surface.test.ts | test | Verifies resolved role surfaces |

The suites under `production-attempt-*` / `production-benchmark-*` / `role-surface` / `identity`
drive a REAL run: `startAttempt` over a scripted Claude child (`request.isolation.spawner`) or the
fake PI runtime, with a test-owned `SessionEngines` pool. No engine or adapter is faked; the raw
normalized-event tap is the run's own, which is why their expected event lists are pinned to what
each backend actually emits.
