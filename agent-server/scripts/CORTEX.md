Please update me when files in this folder change

Build, release, migration, and repository validation scripts.

| filename | role | function |
|---|---|---|
| copy-assets.js | build | Stages CLI and hook assets after compilation |
| copy-web-dist.js | build | Copies the built web SPA into the package |
| lint-no-slack-shortcodes.ts | lint | Checks Slack text for invalid shortcodes |
| migrate-tasks-to-yaml.ts | migration | Migrates task queues to YAML |
| postinstall-restart-trigger.mjs | install | Requests restart after package installation |
| run-tests.sh | test | Runs server tests in an isolated home |
| seed-test-config.sh | test | Seeds isolated test configuration |
| serve-ui-standalone.ts | dev | Starts the standalone UI development server |
| smoke-tui-askuser.mjs | smoke | Runs TUI question-flow smoke checks |
| smoke-tui-mode.mjs | smoke | Runs TUI mode-selection smoke checks |
| smoke-tui-notification-fanout.mjs | smoke | Runs TUI notification fan-out smoke checks |
| smoke-tui-phase2.mjs | smoke | Runs TUI dashboard smoke checks |
| smoke-tui-phase3.mjs | smoke | Runs terminal management-action smoke checks |
| smoke-tui-s2-e2e.mjs | smoke | Runs terminal coexistence smoke checks |
| smoke-tui-s2-live-daemon.mjs | smoke | Runs live-daemon TUI smoke checks |
