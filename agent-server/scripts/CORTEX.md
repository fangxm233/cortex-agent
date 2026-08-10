Please update me when files in this folder change

Build, benchmark, lint, migration, and smoke-test scripts for the agent server package.
They support packaging and manual verification outside the running daemon.

| filename | role | function |
|---|---|---|
| benchmark-pi-provider-discovery.ts | benchmark | measures non-blocking PI provider refresh |
| copy-assets.js | build | makes package CLIs executable and copies hooks |
| copy-web-dist.js | build | stages the built web UI into the package |
| lint-no-slack-shortcodes.ts | lint | flags Slack emoji shortcodes in source |
| stage-bundled-dependencies.mjs | build | Stages and rolls back bundled npm dependencies |
| migrate-tasks-to-yaml.ts | migrate | converts task files from Markdown to YAML |
| postinstall-restart-trigger.mjs | install | signals a running daemon to restart |
| run-tests.sh | test | runs the test suite (isolated + shared shards) in a temporary home, serialized machine-wide via flock and niced |
| seed-test-config.sh | test | writes test machine and Claude/PI profiles |
| serve-ui-standalone.ts | dev | serves the web UI against real local data |
| smoke-tui-askuser.mjs | smoke | checks the ask-user question round trip |
| smoke-tui-mode.mjs | smoke | checks the tmux-backed agent session |
| smoke-tui-notification-fanout.mjs | smoke | checks cross-project notification delivery |
| smoke-tui-phase2.mjs | smoke | checks the five dashboard tab queries |
| smoke-tui-phase3.mjs | smoke | checks dashboard mutation operations |
| smoke-tui-s2-e2e.mjs | smoke | checks live task event delivery |
| smoke-tui-s2-live-daemon.mjs | smoke | checks notifications from the live daemon |
| validate-atif.py | validate | provisions Harbor and validates ATIF trajectories |
