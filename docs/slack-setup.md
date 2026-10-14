# Slack Setup

`cortex init` walks you through the entire Slack side interactively — it
prints the App Manifest, copies it to your clipboard, gives you a
7-step Slack-side checklist, then collects the three tokens with
validation. This document is the standalone reference for the same
flow, useful when:

- you want to read the steps before starting `cortex init`,
- the bot was created by a teammate and you only need to know what
  permissions / events it requires, or
- you need to rotate a token or move the bot to a new workspace.

If you have not run `cortex init` yet and you do not have a specific
reason to read ahead, you can stop reading and just run `cortex init`
— the wizard contains everything below.

## Why Socket Mode

Cortex uses Slack's Socket Mode. The bot opens an outbound WebSocket
to Slack and receives events over it. **No public ingress, no ngrok,
no reverse proxy** — Cortex works behind a corporate firewall, on a
laptop, or in a private VPC with no inbound rules.

The App Manifest Cortex ships sets `socket_mode_enabled: true` and
`interactivity.is_enabled: false`. You will not need to configure a
Request URL.

## Create the Slack App (5 minutes)

1. Open [https://api.slack.com/apps](https://api.slack.com/apps).
2. Click **Create New App → From a manifest**.
3. Pick your workspace.
4. Paste the manifest (full content shown below — `cortex init` also
   prints it and offers to copy it to your clipboard with a single
   keypress). Click **Next** then **Create**.
5. Slack drops you on the app's Basic Information page. Copy the
   **Signing Secret** under "App Credentials" — this is your
   `SLACK_SIGNING_SECRET`.
6. Scroll further down to "App-Level Tokens" → **Generate Token and
   Scopes**. Name it `cortex-socket`, add the `connections:write`
   scope, click **Generate**, and copy the token (starts with `xapp-`)
   — this is your `SLACK_APP_TOKEN`.
7. In the left sidebar go to **OAuth & Permissions** → **Install to
   Workspace** → **Allow**. After install you'll see the **Bot User
   OAuth Token** at the top of the page (starts with `xoxb-`) — this
   is your `SLACK_BOT_TOKEN`.
8. In the left sidebar go to **App Home** → scroll to "Show Tabs" →
   enable the **Messages Tab** and check **"Allow users to send Slash
   commands and messages from the messages tab"**. Without this checkbox you can
   `@cortex` the bot in channels but cannot DM it.

You now have all three secrets. Drop them into `cortex init` when it
asks. If init is already done and you need to update one, edit
`$CORTEX_HOME/config/.env` directly.

## The App Manifest Cortex uses

This is what `cortex init` will paste into your clipboard. You can also
import it manually at <https://api.slack.com/apps> → Create New App →
From a manifest.

```json
{
  "display_information": {
    "name": "Cortex",
    "description": "Autonomous research agent",
    "background_color": "#2c2d30"
  },
  "features": {
    "bot_user": {
      "display_name": "Cortex",
      "always_online": true
    }
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "chat:write",
        "im:history",
        "im:write",
        "reactions:read",
        "reactions:write",
        "users:read",
        "commands",
        "app_mentions:read",
        "channels:history",
        "channels:read",
        "groups:history",
        "files:read",
        "files:write",
        "emoji:read",
        "pins:read",
        "pins:write"
      ]
    }
  },
  "settings": {
    "event_subscriptions": {
      "bot_events": [
        "message.im",
        "message.channels",
        "message.groups",
        "app_mention"
      ]
    },
    "interactivity": {
      "is_enabled": false
    },
    "org_deploy_enabled": false,
    "socket_mode_enabled": true,
    "token_rotation_enabled": false
  }
}
```

### What each scope is for

| Scope                  | Why Cortex needs it                                                                  |
|------------------------|--------------------------------------------------------------------------------------|
| `chat:write`           | Reply in channels and DMs                                                            |
| `im:history`           | Read your DMs to the bot                                                             |
| `im:write`             | Open DMs (e.g. to send the startup notification)                                     |
| `app_mentions:read`    | Receive `@cortex` mentions in channels                                               |
| `channels:history`     | Read messages in public channels the bot is in                                       |
| `channels:read`        | List channels the bot can post in                                                    |
| `groups:history`       | Read messages in private channels the bot is in                                      |
| `reactions:read/write` | Show ✅/❌ for command results and approval decisions                                |
| `users:read`           | Map user IDs to names in transcripts                                                 |
| `files:read/write`     | Receive uploaded files and post generated artifacts (plots, PDFs, logs)              |
| `emoji:read`           | Custom-emoji status indicators                                                       |
| `pins:read/write`      | Pin / unpin key messages                                                             |
| `commands`             | Reserved for future slash commands                                                   |

### What each event is for

| Event              | Triggers                                                  |
|--------------------|-----------------------------------------------------------|
| `message.im`       | Direct messages to the bot (primary chat surface)         |
| `message.channels` | Messages in public channels the bot is invited to         |
| `message.groups`   | Messages in private channels the bot is invited to        |
| `app_mention`      | `@cortex` mentions when the bot is in a channel           |

## Three tokens, where each one comes from

| Token                       | Looks like        | Where in Slack                                                              | Goes into env as          |
|-----------------------------|-------------------|-----------------------------------------------------------------------------|---------------------------|
| Signing Secret              | 32-char hex       | Basic Information → App Credentials                                         | `SLACK_SIGNING_SECRET`    |
| App-Level Token             | `xapp-…`          | Basic Information → App-Level Tokens → Generate Token (scope: `connections:write`) | `SLACK_APP_TOKEN`         |
| Bot User OAuth Token        | `xoxb-…`          | OAuth & Permissions (only appears after "Install to Workspace")             | `SLACK_BOT_TOKEN`         |

`cortex init` validates that the App-Level Token starts with `xapp-`
and the Bot Token starts with `xoxb-` before writing them to `.env`.

## Admin channel: auto-detected, no setup needed

The `adminChannel` setting is the channel Cortex DMs for startup
notifications, approval requests, and other operator-facing chatter.
`cortex init` does not ask for it. The first time you DM the bot, the
Slack adapter records the channel ID and persists it to
`config/settings.json`. See `agent-server/src/platform/adapters/slack.ts`
for the auto-detection path.

If you want to pin it explicitly (e.g. you want admin chatter to land
in a different channel than your DM), grab the channel ID from Slack
(channel name → View channel details → bottom of the page) and set
`adminChannel` in `$CORTEX_HOME/config/settings.json` (see
[configuration.md](./configuration.md#configsettingsjson)):

```json
{
  "adminChannel": "C0123456789"
}
```

A change here reaches the running Slack adapter without a daemon
restart. The legacy `SLACK_ADMIN_CHANNEL` and `CORTEX_ADMIN_CHANNEL`
variables in `.env` are still read as deprecated fallbacks.

## After the bot is in your workspace

Invite the bot to any channel where you want it to listen:

```
/invite @Cortex
```

DMs work without invitation as soon as the Messages Tab is enabled.

To verify the install end-to-end, send the bot a DM. If you see no
reply within ten seconds, check `$CORTEX_HOME/logs/` for connection
errors — the most common ones are an invalid `xapp-` token (Socket
Mode failing to connect) or the Messages Tab still being disabled
(DMs silently ignored). Cortex connects to Slack in the background
after it starts; a connection that keeps failing, or is still not up
a minute after startup, also raises a system notice in the Web UI.

## Rotating or replacing a token

Tokens live in `$CORTEX_HOME/config/.env` (see
[configuration.md](./configuration.md) for the full config reference).
Edit the file directly, then restart the server:

```bash
cortex daemon restart   # drains running work, then restarts the server
```

Or, if you ran `cortex start` in the foreground, Ctrl-C and start
again.

The admin channel auto-detection and DM trust model have safety implications —
see [safety-and-approvals.md](./safety-and-approvals.md).

## Server auto-update on Slack

When Cortex runs in release mode (no `CORTEX_REPO` environment variable),
it periodically checks npm for a newer `@cortex-agent/server` version.
The first check runs 60 seconds after startup, then every 24 hours.

The check is enabled by default. To disable it, set
`"serverUpdateDisable": true` in `$CORTEX_HOME/config/settings.json`
(see [configuration.md](./configuration.md#configsettingsjson)); the legacy
`CORTEX_SERVER_UPDATE_DISABLE=1` variable in `.env` is still read as a
deprecated fallback.

With `serverAutoUpdate` on (the default), a newer version is installed
without asking. Installation waits until no turn is running; from then until
the restart, Cortex refuses new turns and tells the sender to resend. It runs
`npm install -g @cortex-agent/server@<version>` for the exact version it
found, with `--prefix` pinned to the running install: `CORTEX_NPM_PREFIX` if
set, otherwise the prefix the server is installed under, otherwise the prefix
of the `cortex` binary on `PATH`. The package's post-install hook touches
`.restart`, and the daemon restarts `app.js`. Remote clients receive the
matching client release when they reconnect. A failed install is reported in
the Web workbench and retried on the next check.

With `"serverAutoUpdate": false`, Cortex asks first. The Web workbench shows
the question as a dialog; if nobody answers it within 10 minutes, Cortex also
sends an interactive message to the admin DM:

| Button             | Behaviour                                                                                    |
|--------------------|----------------------------------------------------------------------------------------------|
| **Update**         | Agrees to the same install and restart, which wait until no turn is running. |
| **Release Note**   | Posts the release notes for the offered version. |
| **Skip this version** | Dismisses the prompt and records the version in `update-state.json`. The same version will not be prompted again; the next release will trigger a new prompt. |
| **Cancel**         | Dismisses the prompt. The next 24-hour check will re-prompt.                                 |

If no button is pressed within 24 hours, the prompt times out and is
treated as a cancel.

In dev mode (`CORTEX_REPO` points to an existing directory), the check is
skipped entirely since the developer manages the install directly.
