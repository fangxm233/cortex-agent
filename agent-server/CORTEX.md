Please update me when files in this folder change

Cortex agent server: chat bots, LLM orchestration, task dispatch, threads, scheduling, remote device control.
Production code lives in src/, regression tests in tests/, and the install scaffold in defaults/.

| filename | role | function |
|---|---|---|
| defaults/ | subdir | Scaffold copied into a fresh install |
| scripts/ | subdir | Build, benchmark, release and maintenance scripts |
| src/ | subdir | Production TypeScript source |
| tests/ | subdir | Vitest regression suite |
| vendor/ | subdir | Pins local aistatus dependency tarballs |
| README.md | docs | describes the published server package |
| .dependency-cruiser.cjs | config | Guards source-layer dependency direction |
| package.json | config | Builds, packs and exposes runtime binaries |
| package-lock.json | config | Pins registry and vendored dependencies |
| tsconfig.json | config | TypeScript compiler options |
| tsconfig.build.json | config | Compiler options for the dist build |
| vitest.config.ts | config | Unit test runner configuration |
| vitest.integration.config.ts | config | Integration test runner configuration |
