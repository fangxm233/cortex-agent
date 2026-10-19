---
name: browser
description: "Use whenever a task needs a real web browser: verifying or inspecting a web UI (a dev server, a Cortex page, a deployed site), taking a screenshot of a page, reading a page that needs JavaScript or a login, clicking through or operating a website, filling in forms, or checking what a user sees on their own machine. Drive it with the `cortex-browser` CLI. Do not hand-write CDP, puppeteer, playwright or headless-Chrome scripts, and do not launch your own Chrome or Xvfb."
metadata:
  author: "Cortex"
  version: "1.1.0"
  date: "2026-10-19"
---

# Browser

`cortex-browser` is agent-browser attached to a Chrome that Cortex manages. Every session (and
every worker or subagent) gets its own tab, kept between turns. After 10 minutes without a
`cortex-browser` call the tab is closed, and the next call starts on a blank page, so reopen the URL
you need. Logins live in the browser profile, not the tab, and survive that and later sessions.

## Commands

Everything except `--device` is passed to agent-browser. Its full, version-matched guide is one
command away; read it before anything beyond open/snapshot/click rather than guessing flags:

```bash
cortex-browser skills get core          # workflow and common commands
cortex-browser skills get core --full   # every command and option
```

The guide is written for plain `agent-browser`: run its examples as `cortex-browser`, and skip its
advice on `--session`, `--cdp`, `connect` and launching browsers, which Cortex handles.

The usual loop: `cortex-browser open <url>`, then `cortex-browser snapshot -i` to list interactive
elements as refs (`@e1`, `@e2` …), then `click @e2` / `fill @e3 "text"`. Snapshot again after the
page changes: refs from an old snapshot go stale.

## Which machine

- Default is `server`, the Chrome on the Cortex server. There, `localhost` means the server.
- `--device <name>` uses the Chrome on a connected device instead (its `localhost`, its network,
  its logins), and sticks for the rest of the session. Use it when the user asks for their machine
  or when the page only exists there.
- Commands still run on the server, so screenshots and other files land on the server either way.

When `cortex-browser` exits non-zero (device offline, Chrome failed to start, unknown device), the
message says why and what to do. Report that to the user. Switching to a headless script or another
machine without asking hides the failure they need to fix.

## Showing the user

`cortex-browser screenshot ./page.png` (relative paths resolve against your working directory;
`--full` for the whole page), then send it with `send_file`. The user can also watch the browser
live in the **Agent browser** tab of the Cortex app.

## Logins, captchas, 2FA

Don't try to get around them. Ask the user to open the **Agent browser** tab, press **Take over**,
finish the login, and press **Hand back**, then end your turn. When they reply, carry on in the same
tab. While they are in control, `cortex-browser` refuses with "the user is controlling this
browser": wait for them rather than retrying.
