# Opt-in packed local-client verification

**Status: implemented; isolation-only preflight passed. Product acceptance UNRUN.**
The runtime implementation and final integrated tgz are intentionally not consumed here.
No Web build, package installation, login, model call, host service start/restart, or
product-code change is part of this harness.

## Run isolation only

From `/home/fangxin/Cortex-wt-app-local-client-verification/agent-server/tests/local-client-harness`:

```sh
env -i PATH=/usr/bin:/bin LANG=C.UTF-8 /usr/bin/python3 -E -s -B \
  -m unittest -v test_inputs.py
/home/fangxin/.local/opt/node-v22.19.0-linux-x64/bin/node --test checks.test.mjs
for file in *.mjs; do
  /home/fangxin/.local/opt/node-v22.19.0-linux-x64/bin/node --check "$file" || exit
done
env -i PATH=/usr/bin:/bin LANG=C.UTF-8 /usr/bin/python3 -E -s -B preflight.py \
  --node-dir /home/fangxin/.local/opt/node-v22.19.0-linux-x64 \
  --deps /home/fangxin/Cortex-wt-win-build-852f94fdd/node_modules \
  --evidence /home/fangxin/.cortex/tmp/app-local-client/verification
```

Verified: 5 Python boundary tests, 3 Node process-identity tests, all MJS syntax
checks, and 3 isolation/cleanup cases (normal, launcher SIGTERM, launcher SIGKILL).
Machine-readable sanitized evidence is `verification/preflight.json`; each case
names its private run directory. The JSON is generated, not a tracked fixture.

The original failing boundary test was missing `inputs.py`; it passed after the
implementation. During launcher development, an overly broad `ldd` output regex
and missing synthetic `/usr/lib*` parents were corrected. No namespace denial or
host fallback occurred. Final preflight succeeds with the narrow mount policy.

## Later parent invocation — NOT EXECUTED here

Supply the actual product tgz built **after runtime integration**. Do not rebuild
Web, manufacture a bundle, or copy a client into CORTEX_HOME to make this pass.

```sh
env -i PATH=/usr/bin:/bin LANG=C.UTF-8 /usr/bin/python3 -E -s -B accept.py \
  --node-dir /home/fangxin/.local/opt/node-v22.19.0-linux-x64 \
  --deps /home/fangxin/Cortex-wt-win-build-852f94fdd/node_modules \
  --tgz /ABSOLUTE/PARENT/FINAL-INTEGRATED-SERVER.tgz \
  --evidence /home/fangxin/.cortex/tmp/app-local-client/verification
```

`accept.py` owns a fresh host sentinel, launches the isolated foreground owner,
waits at most 330 seconds, verifies namespace teardown, and writes `cleanup.json`.
`launch.py` is internal: use the wrappers so a **real owned host sentinel** exists.
A nonzero exit is a failure, never authorization to try the daemon on the host.
Every run gets a new mode-0700 scratch HOME; there is no state-resume option.
Both cold tests reuse that installation **within the same namespace**.

## Boundary

- bwrap creates new user, PID, network, mount, IPC and UTS namespaces with
  `--die-with-parent`, `--new-session`, `--clearenv`, dropped capabilities, and
  private `/proc`. No slirp, no external interface, no default route or DNS server.
- The host sentinel uses 9880 if free, otherwise a new ephemeral port. The harness
  never connects to host 9880 (which may be live). Inside the namespace, connections
  to the sentinel port, 9880 and 3004 first fail; independent dummy listeners then
  round-trip on those same ports. The host sentinel must receive zero connections.
- Root starts empty; **no host `/`, `/usr`, `/etc`, HOME, `/tmp`, `/run`, credentials,
  sockets or broad library directories are bound**. Exact installed system tools
  and their public shared-library dependencies are read-only. `/bin`, `/lib` and
  `/lib64` are synthetic links; `/etc/passwd`, group, profile, bashrc, hosts and
  npmrc are synthetic/read-only. `bash -l` resolves the synthetic tester HOME/PATH.
- Only the supplied Node/npm tree, extracted server package, dependency roots,
  harness code/control JSON, and exact public tool/library files are inputs.
  The single host-writable bind is the newly owned scratch HOME. `/tmp`, `/run`,
  `/dev` and private proc are namespace-local, not host state. Root is read-only.
- Host credential paths and the corresponding `/proc/1/root` paths are checked
  inaccessible. All six namespace identities differ from the host. Loopback is
  the only interface. Input and synthetic profile writes fail read-only.
- Environment is allowlisted, including HOME/CORTEX_HOME, XDG paths, private npm
  prefix/config/cache, and CLAUDE_CONFIG_DIR. Dummy provider/proxy/BASH_ENV/
  NODE_OPTIONS/CORTEX_REPO poisoning in preflight does not cross the boundary.
  No provider tokens or host configuration are read to construct it.
- Cache symlinks are audited **without following directory links**. Current cache:
  61 links, zero external targets; no supplemental roots needed. Escaping/dangling
  links fail closed. An intentional external package requires an explicit
  `--dependency-root /exact/package/root` with its own package.json. Only that
  exact root is mounted at its original absolute path; never mount its parent
  checkout/home. Relative links remain valid because the cache retains its path.
- Tgz extraction rejects traversal, absolute paths, links and special files.
  `package/node_modules` is linked to the supplied read-only cache. This is a
  **thin-package + cached-dependencies test, NOT npm fresh-dependency-install proof**.
  Inputs are trusted local artifacts; this is not a hostile-archive resource quota
  system or protection against the kernel itself.

## Real-product runner contract

`product.mjs` executes the packed `dist/entry/cortex-cli.js init --json`, with
backends `[pi]`, gpuCount 0, no platforms/services, gateway usage disabled,
localUi `{enabled:true,port:3004}`, localClient `{enabled:true}`, and test-local.
It checks that no client exists before init, init starts no client, and product
init produces `client/local-install.json`, `config/cortex-client.json`, and
`client/current`. The current two-file ordered SHA256 must match packaged
`dist/client-bundle/manifest.json.hash`. Ownership JSON is checked for presence/
object shape; detailed ownership semantics belong to the runtime unit tests.

Only supported `config/settings.json` keys disable unrelated jobs:
`serverUpdateDisable`, `serverAutoUpdate`, `providerUsageCollectionEnabled`,
`anthropicSubscriptionModes`, `memoryIndexRegenEnabled`, `storeArchiveEnabled`.
`clientHotReloadEnabled` remains true to exercise the managed same-package path.
The app may start its real gateway inside the isolated network; no accounts are
created and network cannot escape. No hidden product disable flags are invented.

The packed CLI starts the **real daemon and app.js**. Authentication comes from
this init's existing scratch `.env`: client token for the real WS client, webhook
token for GET `/webhook/devices` and POST `/webhook/remote-command`. HTTP without a
token and HTTP with the client token must fail 401; unauthenticated WS must fail
401. No mock hub, fake client, separate token, or manual prestarted client exists.

The current public HTTP routes omit hello hashes. `observe.mjs` is a test-only
Node preload passed to these owned product children. It adds a passive listener
to the packed app's real `ws.WebSocketServer` after the real verifyClient gate,
recording only test-local hello hash/app PID. It neither changes frames nor bypasses
auth, replaces startup, or implements a supervisor. Online status + authenticated
tool results must also pass; observing an unregistered hello alone cannot pass.

The preload records process starts; a continuous 10ms private `/proc` census
independently counts exact daemon/app/client entry cmdlines and stat start times.
Thus a single online WS is **not** the duplicate check. Startup records catch
short-lived clients between samples once their Node preload runs. An exec killed
before preload and entirely between samples is not exhaustively traced; no kernel
exec tracing is claimed. Disabling/removing inherited NODE_OPTIONS makes the
expected startup-record checks fail, not silently pass.

Each phase verifies harmless Bash Node identity, allowlisted environment, actual
remote write/read, and `exit 7`:

1. Initial: actual authenticated hello with full packaged hash; exactly one client.
2. Warm: three repeated real `daemon` commands; same persistent daemon/app/client
   PID+start identities. Each CLI call forks one daemon contender, which must exit
   after singleton-lock rejection; exactly three rejected contender births are allowed.
   Any extra app/client start still fails, including short-lived processes. This tests
   CLI reopen/idempotence, not the native GUI's healthy-endpoint fast path.
3. Cold with surviving client: stop only the owned daemon/app, prove the exact
   client survived, start daemon, require its new app to receive that client's
   reconnect hello and execute tools; no new client birth.
4. Full cold: stop owned daemon/app, revalidate the known client's start identity
   and exact cmdline before signalling it, start daemon, require a new client
   identity/hello/tools. Total client births must be exactly two, never concurrent.

Stopping a client is permitted only **inside the verified private PID namespace**.
No host process scan ever supplies a PID to kill. Host scans collect namespace
membership/start identities only. Wrappers signal only their Popen-owned launcher;
launcher signals only its Popen-owned bwrap. PID namespace teardown reaps detached
children. Launcher parent death is also coupled via a process-local PDEATHSIG.

## Evidence and limits

Safe outputs: `inputs.json` (including tgz SHA256), `ready.json`, `preflight.json`,
`launcher-result.json`, `cleanup.json`, and HOME `.harness/isolation.json` /
`.harness/acceptance.json` (allowlisted PIDs, namespace IDs, hashes, tool checks).
Do not publish whole run directories. `home/.harness/private-cli-*.log` includes
raw init JSON, and the scratch `.env` contains real generated tokens. Logs, state,
raw stdout, tokens and command headers must never enter a final report or Git.
Failure reports intentionally omit assertion values and raw exception messages.

**Acceptance boundary:** a successful complete run is needed for the supplied tgz;
preflight alone does not establish product lifecycle/tool acceptance. No fresh
 dependency install, Windows/native/UI acceptance,
no login/model/network test. The final artifact may expose missing exact libraries
or a changed runtime contract; stop and report, do not fix product/build fixtures
or loosen isolation here. This Linux harness uses the existing kernel and selected
Node/cache, not a fresh VM/distro. No review or final product run was initiated.
