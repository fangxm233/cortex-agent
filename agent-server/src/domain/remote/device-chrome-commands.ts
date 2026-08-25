// input:  a device's platform
// output: the shell snippets that launch, and stop, a managed Chrome on that device
// pos:    Device browser — everything that must be phrased in the device's own shell
// >>> If I am updated, update CORTEX.md <<<

/**
 * Every command here runs through the device's bash (git-bash on Windows — see
 * `client/src/command-exec.ts`), which is why one snippet shape covers all three platforms and only
 * the binary list and the stop command need dispatching.
 */

/** Profile directory ON THE DEVICE, relative to its own $HOME. Chrome 136+ refuses remote debugging
 *  on the default profile, so a private one is mandatory rather than tidy. */
export const DEVICE_PROFILE_PATH = '.cortex/browser/profile';

/** Chrome writes this file once it is actually listening, and its first line is the port. Waiting on
 *  the file rather than polling HTTP means the device needs no curl, and asking for port 0 means we
 *  never have to guess a free one on a machine we do not own. */
const PORT_FILE = 'DevToolsActivePort';

/** Candidate binaries, most specific first. Absolute paths for the platforms that install to a fixed
 *  location; bare names (resolved with `command -v`) for the ones that do not. */
export function chromeCandidates(platform: string): string[] {
  if (platform === 'win32') {
    return [
      '$PROGRAMFILES/Google/Chrome/Application/chrome.exe',
      // `ProgramFiles(x86)` cannot be referenced as $VAR at all — bash rejects the parentheses
      // inside ${...}, so the value has to come back out through printenv.
      '$(printenv \'ProgramFiles(x86)\')/Google/Chrome/Application/chrome.exe',
      '$LOCALAPPDATA/Google/Chrome/Application/chrome.exe',
    ];
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }
  return [];
}

/** Names looked up on PATH after the absolute candidates miss. */
const PATH_CANDIDATES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome'];

/**
 * Launch (or adopt) the managed Chrome and print the port it is listening on.
 *
 * Adoption first: a device Chrome outlives one turn on purpose, because the whole point of a managed
 * instance is that the human logs in once and the agent inherits the session. A stale port file from
 * a Chrome that has since died is not detected here — the server verifies through the tunnel and
 * relaunches, which is one check instead of shipping an HTTP client to every device.
 */
export function chromeLaunchCommand(platform: string): string {
  const absolute = chromeCandidates(platform)
    .map((p) => `  [ -f "${p}" ] && { CHROME="${p}"; }`)
    .join('\n');
  return [
    `PROFILE="$HOME/${DEVICE_PROFILE_PATH}"`,
    `PORTFILE="$PROFILE/${PORT_FILE}"`,
    'mkdir -p "$PROFILE"',
    // Already listening as far as this device can tell — hand the port back and let the server judge.
    'if [ -s "$PORTFILE" ]; then head -1 "$PORTFILE"; exit 0; fi',
    'CHROME=""',
    ...(absolute ? [`if [ -z "$CHROME" ]; then :\n${absolute}\nfi`] : []),
    `for b in ${PATH_CANDIDATES.join(' ')}; do`,
    '  [ -n "$CHROME" ] && break',
    '  p=$(command -v "$b" 2>/dev/null) && CHROME="$p"',
    'done',
    '[ -n "$CHROME" ] || { echo "chrome-not-found" >&2; exit 3; }',
    // --remote-debugging-address is loopback-only: this is an unauthenticated remote-control port,
    // and the reverse channel is what carries it off the machine, not the network.
    'nohup "$CHROME" --remote-debugging-port=0 --remote-debugging-address=127.0.0.1'
      + ' --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check'
      + ' about:blank >/dev/null 2>&1 &',
    'for _ in $(seq 1 60); do [ -s "$PORTFILE" ] && break; sleep 0.5; done',
    '[ -s "$PORTFILE" ] || { echo "chrome-did-not-listen" >&2; exit 4; }',
    'head -1 "$PORTFILE"',
  ].join('\n');
}

/**
 * Stop the managed Chrome, matching on the profile directory rather than on a pid.
 *
 * The pid is not usable: git-bash reports its own MSYS pid for a Windows child, and Chrome re-parents
 * itself anyway. The profile path is unique to us, so it identifies exactly our instance and never
 * the browser the human is using.
 */
export function chromeStopCommand(platform: string): string {
  const profile = `"$HOME/${DEVICE_PROFILE_PATH}"`;
  if (platform === 'win32') {
    // Stop-Process must swallow its own errors: killing the browser process takes the renderers with
    // it, so by the time the loop reaches them they are already gone.
    const ps = "Get-CimInstance Win32_Process -Filter \\\"Name='chrome.exe'\\\""
      + " | Where-Object { $_.CommandLine -like '*" + DEVICE_PROFILE_PATH.replace(/\//g, '*') + "*' }"
      + ' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';
    return [
      `powershell -NoProfile -Command "${ps}" >/dev/null 2>&1 || true`,
      `rm -f ${profile}/${PORT_FILE}`,
    ].join('\n');
  }
  return [
    `pkill -f -- ${profile} >/dev/null 2>&1 || true`,
    `rm -f ${profile}/${PORT_FILE}`,
  ].join('\n');
}

/** Forget a stale port file so the next launch cannot adopt a Chrome that is no longer there. */
export function chromeResetPortFileCommand(): string {
  return `rm -f "$HOME/${DEVICE_PROFILE_PATH}/${PORT_FILE}"`;
}
