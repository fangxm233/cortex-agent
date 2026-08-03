Update this file whenever this directory changes

Python distribution for installing and validating the Cortex Harbor adapter.

| filename | role | function |
|---|---|---|
| .gitignore | config | Excludes local environments and wheel output |
| pyproject.toml | config | Defines package metadata and dependencies |
| uv.lock | lock | Pins Python dependency resolution |
| scripts/ | tools | Builds the fixed wheel |
| src/ | source | Contains the import package |
| src/cortex_bench_harness/launcher/ | core | Selects arms and builds Harbor configurations |
| src/cortex_bench_harness/scan/ | scan | Detects artifact credentials and host paths |
| tests/ | tests | Verifies package and container behavior |
| tests/scan/ | tests | Proves scans and real offline container runs |
