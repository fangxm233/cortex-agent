Please update me when files in this folder change

Entry-point regressions for runtime wiring and CLI subcommands.

| filename | role | function |
|---|---|---|
| admin-channel-hot-reload.test.ts | test | propagates external admin settings changes |
| boot-jobs.test.ts | test | guards optional boot job timer registration |
| cli-tui-subcommand.test.ts | test | tui argument parsing and daemon detection |
| doctor-cli.test.ts | test | doctor auth probes, output modes and exit codes |
| draft-attachments.test.ts | test | verifies canonical no-overwrite draft promotion |
| hook-cli.test.ts | test | hook metadata, state, execution, ask, packaging |
| production-app-bootstrap.test.ts | test | Proves one-shot server auth is consumed and unlinked before app import |
| production-evidence-export-cli.test.ts | test | Tests evidence export CLI JSON and failures |
| provider-cli.test.ts | test | custom provider CLI parsing, output and exit codes |
| session-retention-app-seam.test.ts | test | guards app retention wiring and startup helpers |
| startup-helpers.test.ts | test | Guards sealed production homes from managed startup config mutation |
