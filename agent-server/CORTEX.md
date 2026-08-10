Please update me when files in this folder change

Cortex agent server: chat bots, LLM orchestration, task dispatch, threads, scheduling, remote device control.
Production code lives in src/, regression tests in tests/, and the install scaffold in defaults/.

| filename | role | function |
|---|---|---|
| defaults/ | subdir | Scaffold copied into a fresh install |
| native/ | subdir | Static Linux process-boundary helpers |
| scripts/ | subdir | Build, benchmark, release and maintenance scripts |
| src/ | subdir | Production TypeScript source |
| tests/ | subdir | Vitest regression suite |
| vendor/ | subdir | Vendored npm tarball dependencies |
| README.md | docs | describes the published server package |
| .dependency-cruiser.cjs | config | Layer and standalone composition dependency rules |
| package.json | config | Builds and packs server, CLIs and native supervisor |
| package-lock.json | config | Locked dependency versions |
| tsconfig.json | config | TypeScript compiler options |
| tsconfig.build.json | config | Compiler options for the dist build |
| vitest.config.ts | config | Unit test runner configuration |
| vitest.integration.config.ts | config | Integration test runner configuration |
