Update this file whenever this directory changes

Python distribution for installing and validating the Cortex Harbor adapter.

| filename | role | function |
|---|---|---|
| .gitignore | config | Excludes local environments and wheel output |
| pyproject.toml | config | Defines package metadata and dependencies |
| uv.lock | lock | Pins Python dependency resolution |
| scripts/ | tools | Builds the fixed wheel |
| src/ | source | Contains the import package |
| tests/ | tests | Verifies package and container behavior |
