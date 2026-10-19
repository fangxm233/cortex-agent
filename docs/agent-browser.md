# Agent Browser

Agents in Cortex drive a real Chrome: they open pages, read them, click through them, fill in
forms and take screenshots. The browser is the one Cortex manages on the server, or the Chrome on
one of your connected machines, and you can watch it live in the app and take over when a page
needs a human.

Agents control it with the `cortex-browser` command, which runs in their shell like any other
tool. The built-in `browser` skill (in the `cortex-system` plugin) tells an agent when and how to
use it, so asking for "check the page", "take a screenshot of the dashboard" or "log in and look"
is enough.

## How an agent uses it

`cortex-browser` is [agent-browser](https://github.com/vercel-labs/agent-browser) attached to a
Chrome that Cortex manages. Every argument except `--device` goes to agent-browser, so the command
set is agent-browser's: `open`, `snapshot`, `click`, `fill`, `screenshot`, `get`, `eval` and the
rest. The usual loop is:

```bash
cortex-browser open http://127.0.0.1:5173
cortex-browser snapshot -i              # interactive elements as refs: @e1, @e2 …
cortex-browser click @e2
cortex-browser screenshot ./after.png
```

The full, version-matched command guide ships with the binary:
`cortex-browser skills get core` (add `--full` for every command and option). The
[CLI reference](cli-reference.md#cortex-browser) lists what `cortex-browser` itself adds and
refuses.

Relative file paths (`screenshot ./page.png`, `pdf out.pdf`, `upload @e5 a.png`) resolve against
the agent's working directory. Files always land on the server, whichever machine's Chrome took
them; the agent sends a screenshot to you with `send_file`.

## One tab per session

Each session gets its own tab, and so does each worker and subagent, because they run as sessions
of their own. The tab stays between turns, so an agent continues on the page where it left off.
Sessions never share a tab and cannot see each other's.

A session's tab closes after 10 minutes without a `cortex-browser` call. The next call starts on a
blank page and says so; the agent reopens the URL it needs. If Chrome stops for another reason,
such as a crash or a machine restart, the next call starts Chrome again and continues the same way.
Chrome itself shuts down 10 minutes after the last session's tab on it closes.

Logins live in the browser profile, not in the tab, so a site you signed in to stays signed in for
later tabs and later sessions. On the server the profile is `$CORTEX_HOME/browser/profile/`
(`~/.cortex/browser/profile/` by default); on a device it is `~/.cortex/browser/profile/` in the
home of the user running `cortex-client`. Each is separate from your everyday
Chrome profile.

## Choosing the machine

- **`server`** (the default) is the Chrome on the Cortex server. There, `localhost` means the
  server. It runs on the server's display when there is one, otherwise on a virtual display
  (when `Xvfb` is installed) or headless. The live view and takeover in the app go through Chrome's
  debugging connection, so they work in every case.
- **`--device <name>`** uses the Chrome on a connected machine instead: its `localhost`, its
  network and its logins. Cortex starts that Chrome through the machine's `cortex-client` and
  reaches its debugging port through the client's [port forwarding](cross-machine.md#port-forwarding),
  so nothing extra needs to be open on the machine. Chrome or Chromium has to be installed there.

The choice sticks: once a session has used a device, later calls go there without repeating
`--device`. Choosing another machine closes the session's tab on the previous one. An agent picks
a device when you ask for your machine, or when the page only exists there.

When the browser cannot be used, `cortex-browser` exits non-zero and says why and what to do: the
device is offline or unknown, Chrome failed to start, or you are controlling the browser.

## Watching it in the app

When a session has a browser, the chat header shows a **Browser** capsule with the machine and the
browser's state: starting, failed to start, on a page, or **You are in control**. Clicking it
opens the session's **Agent browser** tab in the dock, which shows the page live. The command
palette (`⌘K` / `Ctrl+K`) lists every live agent browser under **Agent browsers**, so you can open
one from any session. The view streams only while the tab is visible.

On a phone, the chat's activity strip shows the browser chip, and tapping it opens a read-only
view of the page.

## Taking over

Some pages need a person: a login, a captcha, a second factor, a cookie banner the agent cannot
get past. The skill tells the agent to ask you rather than work around them. To step in:

1. Open the session's **Agent browser** tab and press **Take over**.
2. Use the page directly: clicks, scrolling and keys go to the page. The tab's text field types
   into the focused element, and pasting from the clipboard does the same.
3. Press **Hand back**, then reply in the chat so the agent carries on in the same tab.

While you are in control, the agent's `cortex-browser` calls are refused with "the user is
controlling this browser", and the agent waits for you. A takeover belongs to the window that made
it; another window can take it over in turn. Cortex hands the browser back by itself 30 seconds
after the controlling window's view goes away (the dock tab closed, the page reloaded, the network
dropped) or after 10 minutes without a click, key or paste.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `CORTEX_AGENT_BROWSER_BIN` | the agent-browser binary shipped with Cortex | Absolute path of the agent-browser binary `cortex-browser` runs. A path that does not exist is an error, not a fallback |
| `CORTEX_BROWSER_BINARY` | auto-detected | Chrome or Chromium binary for the server's browser |
| `CORTEX_BROWSER_DISPLAY` | auto-detected | X display the server's browser uses, skipping display detection |

Cortex uses its own pinned agent-browser, never one found on `PATH`, so the command guide always
matches the commands. See [Configuration](configuration.md#tuning-and-debugging) for where these
variables live.
