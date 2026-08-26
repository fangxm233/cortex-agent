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
const WINDOWS_TASK_NAME = 'Cortex Managed Browser';

/** Windows OpenSSH and WMI both run in Session 0. The client stays there, but this task uses the
 * logged-in user's interactive token so Chrome itself appears on that user's desktop. */
const WINDOWS_LAUNCH_SCRIPT = `
$ErrorActionPreference = "Stop"
$profile = Join-Path $env:USERPROFILE ".cortex\\browser\\profile"
$portFile = Join-Path $profile "${PORT_FILE}"
New-Item -ItemType Directory -Force -Path $profile | Out-Null
if ((Test-Path -LiteralPath $portFile) -and (Get-Item -LiteralPath $portFile).Length -gt 0) {
  Get-Content -LiteralPath $portFile -TotalCount 1
  exit 0
}
$candidates = @(
  (Join-Path $env:ProgramFiles "Google\\Chrome\\Application\\chrome.exe"),
  (Join-Path ([Environment]::GetEnvironmentVariable("ProgramFiles(x86)")) "Google\\Chrome\\Application\\chrome.exe"),
  (Join-Path $env:LOCALAPPDATA "Google\\Chrome\\Application\\chrome.exe")
)
$chrome = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if (-not $chrome) {
  foreach ($name in @("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome")) {
    $found = Get-Command $name -ErrorAction SilentlyContinue
    if ($found) { $chrome = $found.Source; break }
  }
}
if (-not $chrome) { [Console]::Error.WriteLine("chrome-not-found"); exit 3 }
$user = (Get-CimInstance Win32_ComputerSystem).UserName
if (-not $user) { [Console]::Error.WriteLine("no-interactive-user"); exit 5 }
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
if ($user -ine $current) { [Console]::Error.WriteLine("interactive-user-mismatch"); exit 6 }
$quote = [char]34
$arguments = "--remote-debugging-port=0 --remote-debugging-address=127.0.0.1 --user-data-dir=$quote$profile$quote --no-first-run --no-default-browser-check about:blank"
$action = New-ScheduledTaskAction -Execute $chrome -Argument $arguments
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "${WINDOWS_TASK_NAME}" -Action $action -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName "${WINDOWS_TASK_NAME}"
for ($i = 0; $i -lt 60; $i++) {
  if ((Test-Path -LiteralPath $portFile) -and (Get-Item -LiteralPath $portFile).Length -gt 0) { break }
  Start-Sleep -Milliseconds 500
}
if (-not ((Test-Path -LiteralPath $portFile) -and (Get-Item -LiteralPath $portFile).Length -gt 0)) {
  [Console]::Error.WriteLine("chrome-did-not-listen")
  exit 4
}
Get-Content -LiteralPath $portFile -TotalCount 1
`.trim();

function unixChromeLaunchCommand(platform: string): string {
  const absolute = chromeCandidates(platform)
    .map((p) => `  [ -f "${p}" ] && { CHROME="${p}"; }`).join('\n');
  return [
    `PROFILE="$HOME/${DEVICE_PROFILE_PATH}"`, `PORTFILE="$PROFILE/${PORT_FILE}"`,
    'mkdir -p "$PROFILE"',
    'if [ -s "$PORTFILE" ]; then head -1 "$PORTFILE"; exit 0; fi', 'CHROME=""',
    ...(absolute ? [`if [ -z "$CHROME" ]; then :\n${absolute}\nfi`] : []),
    `for b in ${PATH_CANDIDATES.join(' ')}; do`, '  [ -n "$CHROME" ] && break',
    '  p=$(command -v "$b" 2>/dev/null) && CHROME="$p"', 'done',
    '[ -n "$CHROME" ] || { echo "chrome-not-found" >&2; exit 3; }',
    'nohup "$CHROME" --remote-debugging-port=0 --remote-debugging-address=127.0.0.1'
      + ' --user-data-dir="$PROFILE" --no-first-run --no-default-browser-check'
      + ' about:blank >/dev/null 2>&1 &',
    'for _ in $(seq 1 60); do [ -s "$PORTFILE" ] && break; sleep 0.5; done',
    '[ -s "$PORTFILE" ] || { echo "chrome-did-not-listen" >&2; exit 4; }', 'head -1 "$PORTFILE"',
  ].join('\n');
}

/** Launch (or adopt) managed Chrome and print its debugging port. */
export function chromeLaunchCommand(platform: string): string {
  if (platform === 'win32') {
    return `powershell.exe -NoProfile -Command '${WINDOWS_LAUNCH_SCRIPT}' </dev/null`;
  }
  return unixChromeLaunchCommand(platform);
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
    const script = [
      '$ErrorActionPreference = "SilentlyContinue"',
      `Stop-ScheduledTask -TaskName "${WINDOWS_TASK_NAME}" -ErrorAction SilentlyContinue`,
      'Get-CimInstance Win32_Process | Where-Object {',
      '  $_.Name -eq "chrome.exe" -and $_.CommandLine -like "*.cortex*browser*profile*"',
      '} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
    ].join('\n');
    return [
      `powershell.exe -NoProfile -Command '${script}' </dev/null >/dev/null 2>&1 || true`,
      `rm -f ${profile}/${PORT_FILE}`,
    ].join('\n');
  }
  return [
    `pkill -f -- ${profile} >/dev/null 2>&1 || true`,
    `rm -f ${profile}/${PORT_FILE}`,
  ].join('\n');
}
