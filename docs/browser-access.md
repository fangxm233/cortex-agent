# Browser Access & Deployment

Cortex ships a browser workbench — the same SPA the [desktop app](desktop-app.md) wraps —
reachable from any browser without installing anything. This page covers **both** the
deployment runbook (building the SPA and enabling the Web UI endpoint on your server) and
the browser access path (reaching it through Cloudflare Access edge login).

There are three independent ways to reach the workbench, and they authenticate differently:

| Path | Who | Authentication | Holds `clientToken`? |
|---|---|---|---|
| **Browser + Access** | Anyone with a browser | Cloudflare Access edge login (email / IdP), verified as a JWT by the server | **No** — the browser never sees the token |
| **Browser + token login** | Anyone who knows the token | The token is pasted once and exchanged for an HttpOnly session cookie | **No** — only the server sees it, and only once |
| **Desktop (Tauri)** | The installed desktop app | Bearer `x-cortex-token` (the `clientToken`) stored in the OS keychain | Yes |

This page is the browser + deployment reference. For installing the native desktop app, see
[Desktop App](desktop-app.md).

## The in-core Web UI transport

The Web UI transport ships **in-core** with `@cortex-agent/server` and is **loaded on demand**
behind the `CORTEX_UI_HTTP` flag. It pulls `@trpc/server` and `jose`, but these are
**runtime-lazy**: the server imports the transport only through a dynamic import that is reached
solely when the flag is set. When the flag is unset, neither the transport code nor `@trpc/server`
/ `jose` ever enter the runtime module graph, so a Slack- or TUI-only deployment pays zero UI
weight — while installing and upgrading stay a single `npm install -g @cortex-agent/server`.

When enabled, the transport:

- serves the built SPA (`web/dist`) **same-origin** with the tRPC API — one port, one origin,
  so the browser loads `index.html` + assets and calls `/trpc` with no cross-origin plumbing;
- exposes the tRPC API at `/trpc` (HTTP batch for queries/mutations, SSE for subscriptions),
  connected in-process directly to the server's domain services (no proxy, no sidecar);
- gates every `/trpc` request behind a **dual-path auth** check (see
  [Authentication](#authentication)).

It runs in the same process as the server, binds to `127.0.0.1`, and is meant to be exposed
to the internet only through a tunnel.

## Deployment runbook (source → running server)

These steps take you from a fresh checkout to a Cortex server serving the browser workbench.

### 1. Prerequisites

- Node.js ≥ 20 and [pnpm](https://pnpm.io) (this repo is a pnpm workspace).
- A running Cortex server (see [Quickstart](quickstart.md)).

### 2. Build the SPA

The web SPA is built to `web/dist`. From the repo root:

```bash
pnpm install            # install workspace dependencies
pnpm -r run build       # build every workspace package, including web → web/dist
```

To build only the SPA and its dependencies:

```bash
pnpm --filter @cortex-agent/ui-contract run build
pnpm --filter web run build      # produces web/dist
```

`web/dist` is a plain static bundle (`index.html` + hashed assets). When the `@cortex-agent/server`
package is published, `web/dist` is staged into the package (via a `prepack` step) and shipped in
its `files`, so an installed server can serve the SPA with no extra build. From a source checkout
you build it yourself with the step above.

### 3. Where `web/dist` is served from

The server resolves the SPA directory in this order:

1. an explicit directory you pass to it;
2. the `CORTEX_UI_SPA_DIR` environment variable;
3. the package-root `web/dist` (present in an installed/published package);
4. the monorepo's `web/dist` (when running from a source checkout).

If you deploy an installed package, option 3 works out of the box. If you deploy from a repo
checkout, option 4 works with no configuration — build `web/dist` in place and it is served
automatically. If you deploy the built SPA to a different location, point `CORTEX_UI_SPA_DIR` at
it. If the directory is absent (SPA not built), non-`/trpc` paths return a 404 placeholder while
`/trpc` still works.

### 4. Enable the Web UI endpoint

Add to `~/.cortex/config/.env` on the server:

```bash
CORTEX_UI_HTTP=1          # opt-in: start the tRPC HTTP + SSE endpoint (required)
CORTEX_UI_PORT=3004       # optional; defaults to 3004
```

This alone is enough to open the workbench from a browser: token login is on by default, so the
SPA will ask for the `clientToken` and exchange it for a session (see
[Browser access with a token](#browser-access-with-a-token-no-cloudflare)).

`CORTEX_UI_HTTP` accepts `1`, `true`, `on`, or `yes`. With it unset, the endpoint — and the
Web UI transport, along with `@trpc/server` / `jose` — never loads.

### 5. Restart the daemon to apply

The daemon reads the SPA and env at startup, so a new build or env change takes effect on
restart:

```bash
cortex daemon   # or: systemctl --user restart cortex (if you registered a service)
```

!!! warning "Restarting is disruptive"
    Restarting the daemon interrupts any in-flight agents, threads, and scheduled work.
    Treat it as a deliberate, controlled action — schedule it when the system is idle, and
    if your Cortex instance runs under an approval policy, route the restart through that
    approval step rather than restarting ad hoc.

At this point the server is reachable at `http://127.0.0.1:3004` **on the server host only**.
Exposing it to a browser is the next section.

## Authentication

The `/trpc` auth gate accepts a request if **any** of three credentials is valid, and returns
`401` before tRPC runs otherwise:

1. **`x-cortex-token` header** equal to the server's `clientToken` — the desktop / machine
   path. Checked first, with a constant-time comparison. Unchanged from before.
2. **A live `cortex_ui` session cookie** — the token-login browser path. Minted by
   `POST /api/ui/login` after the browser proves, once, that it knows the token.
3. **A valid `Cf-Access-Jwt-Assertion` header** — the Cloudflare Access browser path. The edge
   injects this JWT after it authenticates the user; the server verifies it.

Either browser path keeps the `clientToken` out of the page: the cookie is `HttpOnly`, so the
SPA's own JavaScript cannot read it, and the Access JWT is issued by the edge.

The server verifies the Access JWT against your Cloudflare Access team-domain JWKS, checking
the signature (RS256 / ES256 only), the audience (AUD) tag, the issuer, and expiry. If Access
is **not** configured on the server, the JWT path is disabled and the gate securely degrades —
an unconfigured Access path never admits a request.

!!! warning "The port forward is token-only, on purpose"
    `/forward` (the desktop shell's raw TCP tunnel to a loopback service on the server) accepts
    **only** the `x-cortex-token` header. Neither browser credential opens it. A browser attaches
    cookies to a WebSocket handshake automatically, so admitting the session cookie there would
    hand every logged-in page a raw socket to every loopback service on the host.

## Browser access via Cloudflare Access

The browser path puts a **Cloudflare Access edge login in front of a dedicated UI hostname**,
so users log in with email / IdP at the edge and the server only ever sees an already-verified
request.

```
browser
  │  https (Cloudflare Access: email / IdP login at the edge)
  ▼
Cloudflare Tunnel   (cortex-ui.example.com  →  server localhost:3004)
  │  edge injects  Cf-Access-Jwt-Assertion  on every request
  ▼
agent-server Web UI transport  (verifies the JWT; the browser never holds clientToken)
  ├─ serves web/dist  (same-origin SPA)
  └─ serves /trpc     (same-origin real data, in-process)
```

### 1. Create a dedicated UI hostname and tunnel route

Point a Cloudflare Tunnel route from a **new** public hostname (for example
`cortex-ui.example.com`) to the server's loopback endpoint (`http://127.0.0.1:3004`, or your
`CORTEX_UI_PORT`).

!!! danger "Use a separate hostname from the cortex-client endpoint"
    The hostname your remote `cortex-client` instances connect to must **not** be placed behind
    Cloudflare Access — Access would block the WebSocket clients. Always give the browser UI its
    **own** hostname and apply Access only to that one.

### 2. Add a Cloudflare Access application (account-side ops)

In the Cloudflare Zero Trust dashboard, create a **self-hosted Access application** for the UI
hostname with a policy that allows your login email (or IdP group). This is an account-level
operation performed in the Cloudflare dashboard, not in Cortex config. Note the application's
**AUD tag** — you need it below.

### 3. Configure the server to verify Access JWTs

Add to `~/.cortex/config/.env` on the server:

```bash
CORTEX_ACCESS_TEAM_DOMAIN=your-team      # bare team name, or your-team.cloudflareaccess.com
CORTEX_ACCESS_AUD=<your-access-app-AUD>  # the Access application's AUD tag
# CORTEX_ACCESS_CERTS_URL=...            # optional: override the derived JWKS URL
```

From `CORTEX_ACCESS_TEAM_DOMAIN` the server derives the issuer
(`https://your-team.cloudflareaccess.com`) and the JWKS URL
(`https://your-team.cloudflareaccess.com/cdn-cgi/access/certs`). If **either**
`CORTEX_ACCESS_TEAM_DOMAIN` or `CORTEX_ACCESS_AUD` is unset, the browser path stays disabled
(token-only). Restart the daemon after changing these values.

### 4. Open the workbench

Navigate to `https://cortex-ui.example.com`. Cloudflare Access challenges you for email / IdP
login; after you authenticate, the edge forwards every request with a verified
`Cf-Access-Jwt-Assertion`, the server serves the same-origin SPA, and the workbench loads real
tRPC data — no token, no local install.

## Browser access with a token (no Cloudflare)

If you do not run Cloudflare Access — or you just want to open the workbench from a laptop on
the LAN or through an SSH forward — a browser can authenticate itself by pasting the server's
`clientToken` once.

**This is on by default** on any server with `CORTEX_UI_HTTP=1`. Open the UI, and if the browser
holds no session yet the SPA shows a sign-in screen instead of the workbench:

```
browser  ──POST /api/ui/login {token}──▶  server   (constant-time compare vs clientToken)
        ◀──Set-Cookie: cortex_ui=… ; HttpOnly; SameSite=Strict; Secure──
browser  ──every later /trpc, /api request carries the cookie──▶  server
```

What that buys, and what it costs:

- **The token is submitted once.** It is exchanged for an opaque 32-byte session id. The cookie is
  `HttpOnly`, so page JavaScript — including an XSS payload — cannot read it back out.
- **`SameSite=Strict`** means no cross-site request ever carries the session, which is the whole
  CSRF story. The login POST additionally refuses a request whose `Origin` is not this host.
- **Sessions survive a daemon restart.** They live in `~/.cortex/data/ui-sessions.json` (mode
  `0600`) and expire 30 days after they are issued. Settings → Advanced has a
  *Sign out of this browser* button, which revokes the session server-side.
- **A session is strictly weaker than the token.** It carries exactly the authority of a
  Cloudflare Access login: tRPC and the `/api` routes, never `/forward`.
- **The login endpoint is public.** It has to be — a browser with no credential must be able to
  reach it. A wrong token costs the caller a fixed 250 ms and is logged; the token itself is 32
  random bytes, so online guessing is not a realistic attack. There is deliberately no IP ban
  (behind a tunnel every request appears to come from `127.0.0.1`) and no global lockout (which
  would let anyone lock you out of your own server).

### Tuning or turning it off

```bash
CORTEX_UI_TOKEN_LOGIN=0          # remove the login routes and the cookie leg entirely
CORTEX_UI_SESSION_TTL_DAYS=30    # optional; session lifetime, default 30 days
```

With token login off, the server behaves exactly as it did before this existed: header token and
(if configured) Cloudflare Access only. The SPA then says so on the sign-in screen rather than
offering a form that could not work.

### Where to use which

Put Cloudflare Access in front of a UI hostname when you want IdP-managed access for people who
should never see the token, or when the UI is exposed to the open internet. Use token login for
your own access — over a tunnel, a VPN, Tailscale, an SSH forward, or plain loopback. The two
coexist: a server can have both, and each request is admitted by whichever credential it carries.

!!! note "Plain HTTP on a LAN"
    The session cookie is marked `Secure` when the request arrived over HTTPS (or from
    `localhost`). Over plain HTTP to a LAN address it cannot be — a browser would silently drop a
    `Secure` cookie — so the cookie is issued without it and the daemon logs a warning. Anyone on
    that network path can read the session. Use HTTPS for anything beyond a trusted LAN.

## The three paths side by side

All three reach the same `/trpc` API and the same workbench, but they differ in **where** and
**how** they authenticate:

| | Browser + Access | Browser + token login | Desktop (Tauri) |
|---|---|---|---|
| Hostname | Dedicated UI hostname **behind** Cloudflare Access | Any hostname that reaches the port | A hostname **not** behind Access |
| Login | Cloudflare Access edge login (email / IdP) | Paste the `clientToken` once | Enter `serverUrl` + `clientToken` once |
| Credential on requests | `Cf-Access-Jwt-Assertion` (issued by the edge) | `cortex_ui` session cookie | `x-cortex-token` header |
| Where auth is checked | JWT verified by the server | Session verified by the server | Token verified by the server |
| `clientToken` exposure | **Never touches the browser** | Typed once, never stored in the page | Stored in the OS keychain |
| Opens `/forward` | No | No | Yes |
| SPA origin | Same-origin (SPA + `/trpc` on one host) | Same-origin | Direct connection to `/trpc` (CORS-enabled) |

Because the desktop app sends `x-cortex-token`, it must connect through a hostname that is
**not** behind Cloudflare Access (Access would block the bearer request at the edge). Choose the
desktop app when you want a native window, the port forward, and are comfortable storing the
token locally; Access when other people need in and should never see the token; token login when
it is your own browser and the path to the server is already private or encrypted.

## Troubleshooting

**Browser gets a Cloudflare login loop or `403` at the edge**

The Access application policy does not allow your identity. Check the policy on the UI
hostname's Access application in the Cloudflare Zero Trust dashboard.

**Browser logs in at the edge but the workbench shows `401` / no data**

The edge authenticated you but the server rejected the JWT. Confirm on the server that
`CORTEX_ACCESS_TEAM_DOMAIN` matches your team and `CORTEX_ACCESS_AUD` matches the Access
application's AUD tag exactly, and that the daemon was restarted after setting them. With those
unset, the browser path is disabled and every browser request is `401`.

**The sign-in screen says token sign-in is turned off**

`CORTEX_UI_TOKEN_LOGIN` is set to `0` on the server. Either remove it (token login is on by
default) and restart, or reach the UI through Cloudflare Access / the desktop app instead.

**The token is correct but signing in does nothing / it asks again on every page load**

The browser is dropping the session cookie. This happens over plain HTTP to a non-loopback host
if a proxy in front terminates TLS but does not pass `X-Forwarded-Proto: https` — the server then
issues the cookie without `Secure`, which some browsers refuse on a page they consider secure.
Check the daemon log for the "issued without Secure" warning, and make the proxy forward the
header.

**The page loads but `/trpc` calls `404`**

`web/dist` was not found, so only the API is served. Build the SPA (`pnpm --filter web run
build`) or point `CORTEX_UI_SPA_DIR` at your built bundle, then restart.

**Nothing is reachable at the UI hostname**

1. Confirm `CORTEX_UI_HTTP=1` is set and the daemon was restarted after adding it.
2. On the server, confirm the endpoint is up: `curl http://127.0.0.1:3004/trpc` should return a
   tRPC error (not connection-refused).
3. Confirm the Cloudflare Tunnel is running and its route points at the correct port.
