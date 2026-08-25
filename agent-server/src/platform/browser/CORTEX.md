Please update me when files in this folder change

The managed browser: one Chrome instance, shared by every session that opted into browser control
(plan/embedded-browser.md §16-§17). Sessions reach it through Playwright MCP over CDP; a human
reaches the same browser through their desktop session, which is what makes hand-performed logins
usable by the agent.

| filename | role | function |
|---|---|---|
| display.ts | policy | Decides attached/virtual/headless display and whether a human can take over |
| managed-browser.ts | lifecycle | Launches, refcounts, restarts and reclaims the shared Chrome |
