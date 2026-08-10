Please update me when files in this folder change

Real-process integration coverage for Linux native helpers and containment boundaries.

| filename | role | function |
|---|---|---|
| fixtures/ | fixtures | Provides hostile process-tree test programs |
| integration-supervisor.test.ts | test | Verifies lifecycle and control-loss containment |
| package-supervisor.test.ts | test | Verifies packing, rollback, binary mode, and digest |
| supervisor-harness.ts | helper | Drives supervisor teardown and leak probes |
