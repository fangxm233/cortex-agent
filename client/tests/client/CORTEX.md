Please update me when files in this folder change

Regression tests for cortex-client connection setup and for the cortex-run
launch, cancel, callback, and command execution handlers.

| filename | role | function |
|---|---|---|
| auth-headers.test.ts | test | Covers token resolution and auth headers |
| command-exec.test.ts | test | Covers timeout and process-tree termination |
| cortex-run-launch.test.ts | test | Covers launch/cancel, callback payloads, orphan recovery and file utilities |
| reverse-stream.test.ts | test | Covers the loopback-only target policy, callback URLs and stream teardown |
| server-url.test.ts | test | Covers server URL precedence and defaults |
