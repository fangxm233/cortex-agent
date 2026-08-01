#!/bin/bash
# input:  agent-run flags and dummy proxy environment
# output: C2/C3 artifacts, benign stdio, and workspace change
# pos:    Deterministic container-side benchmark agent stub
# >>> If I am updated, update my header and folder CORTEX.md <<<

set -euo pipefail

parse_arguments() {
  [[ "${1:-}" == "agent-run" ]] || return 64
  shift
  while (($#)); do
    case "$1" in
      --prompt-file) prompt_file="$2"; shift 2 ;;
      --cwd) task_cwd="$2"; shift 2 ;;
      --events-file) events_file="$2"; shift 2 ;;
      --trajectory-root) trajectory_root="$2"; shift 2 ;;
      --root-run-id) root_run_id="$2"; shift 2 ;;
      *) shift 2 ;;
    esac
  done
  : "${prompt_file:?}" "${task_cwd:?}" "${events_file:?}"
  : "${trajectory_root:?}" "${root_run_id:?}"
}

sha_text() {
  printf '%s' "$1" | sha256sum | cut -d' ' -f1
}

utc_now() {
  date -u +'%Y-%m-%dT%H:%M:%S.%3NZ'
}

write_started_marker() {
  local timestamp="$1"
  local output="$trajectory_root/run-$root_run_id.started.json"
  local temporary="$output.tmp.$$"
  printf '{"root_run_id":"%s","thread_id":null,"ts":"%s","journal_path":"events.jsonl"}\n' \
    "$root_run_id" "$timestamp" > "$temporary"
  sync "$temporary"
  mv "$temporary" "$output"
}

write_journal_header() {
  local timestamp="$1"
  local prompt_hash
  prompt_hash="$(sha256sum "$prompt_file" | cut -d' ' -f1)"
  printf '{"schema_version":"cortex-bench-journal/1","type":"run_header","root_run_id":"%s","thread_id":null,"agent_slot":"parent","seq":0,"ts":"%s","resolved_cwd":"%s","canonical_instruction_sha256":"%s","model_visible_prompt_sha256":"%s","system_prompt_sha256":"%s","tool_manifest_sha256":"%s","plugin_manifest_sha256":"%s","model_execution_identity_hash":"%s","role_tool_surface_hash":"%s","bundle_manifest_hash":"%s"}\n' \
    "$root_run_id" "$timestamp" "$task_cwd" "$prompt_hash" "$prompt_hash" \
    "$system_hash" "$tool_hash" "$plugin_hash" "$model_hash" "$role_hash" \
    "$bundle_hash" > "$events_file"
}

request_proxy() {
  local target="${ANTHROPIC_BASE_URL#http://}"
  local host="${target%:*}"
  local port="${target##*:}"
  local body='{"model":"claude-synthetic-1","prompt":"stub request"}'
  exec 3<>"/dev/tcp/$host/$port"
  printf 'POST /v1/messages HTTP/1.1\r\nHost: %s\r\nAuthorization: Bearer %s\r\nContent-Type: application/json\r\nContent-Length: %s\r\nConnection: close\r\n\r\n%s' \
    "$host" "$ANTHROPIC_AUTH_TOKEN" "${#body}" "$body" >&3
  proxy_response="$(cat <&3)"
  exec 3>&-
  [[ "$proxy_response" == HTTP/*' 200 '* ]]
}

write_events() {
  local assistant_ts complete_ts
  assistant_ts="$(utc_now)"
  complete_ts="$(utc_now)"
  printf '{"schema_version":"cortex-bench-journal/1","type":"event","root_run_id":"%s","thread_id":null,"step":1,"agent_slot":"parent","seq":1,"ts":"%s","backend":"claude","provider":null,"requested_model":"claude-synthetic-1","reported_model":null,"model_execution_identity_hash":"%s","role_tool_surface_hash":"%s","bundle_manifest_hash":"%s","event":{"type":"assistant_text","text":"stub request completed","model":null}}\n' \
    "$root_run_id" "$assistant_ts" "$model_hash" "$role_hash" "$bundle_hash" \
    >> "$events_file"
  printf '{"schema_version":"cortex-bench-journal/1","type":"event","root_run_id":"%s","thread_id":null,"step":1,"agent_slot":"parent","seq":2,"ts":"%s","backend":"claude","provider":null,"requested_model":"claude-synthetic-1","reported_model":null,"model_execution_identity_hash":"%s","role_tool_surface_hash":"%s","bundle_manifest_hash":"%s","event":{"type":"turn_complete","numTurns":1,"totalCostUsd":null}}\n' \
    "$root_run_id" "$complete_ts" "$model_hash" "$role_hash" "$bundle_hash" \
    >> "$events_file"
  sync "$events_file"
}

write_terminal_manifest() {
  local started_at="$1" ended_at journal_hash output temporary
  ended_at="$(utc_now)"
  journal_hash="$(sha256sum "$events_file" | cut -d' ' -f1)"
  output="$trajectory_root/run-$root_run_id.terminal.json"
  temporary="$output.tmp.$$"
  printf '{"schema_version":"cortex-bench-manifest/1","state":"completed","started_at":"%s","ended_at":"%s","journal_path":"events.jsonl","journal_sha256":"%s","event_count":2,"supervisor":{"quiescent":true,"descendants":0},"steps":1,"cost_usd":null,"tokens":{"input":null,"output":null},"model_execution_identity_hash":"%s","role_tool_surface_hash":"%s","bundle_manifest_hash":"%s","terminal_reason":"ok"}\n' \
    "$started_at" "$ended_at" "$journal_hash" "$model_hash" "$role_hash" \
    "$bundle_hash" > "$temporary"
  sync "$temporary"
  mv "$temporary" "$output"
}

emit_outputs() {
  printf '%s\n' 'stub-agent request_status=200 workspace_modified=true' \
    | tee -a "$trajectory_root/../stdout.txt"
  printf '%s\n' 'stub-agent journal_status=committed terminal_status=completed' \
    | tee -a "$trajectory_root/../stderr.txt" >&2
}

parse_arguments "$@"
mkdir -p "$trajectory_root"
: > "$trajectory_root/../stdout.txt"
: > "$trajectory_root/../stderr.txt"
model_hash="$(sha_text model-execution-identity)"
role_hash="$(sha_text role-tool-surface)"
bundle_hash="$(sha_text bundle-manifest)"
system_hash="$(sha_text system-prompt)"
tool_hash="$(sha_text tool-manifest)"
plugin_hash="$(sha_text plugin-manifest)"
started_at="$(utc_now)"
write_started_marker "$started_at"
write_journal_header "$started_at"
request_proxy
printf '%s\n' 'synthetic workspace result' > "$task_cwd/solution.txt"
write_events
write_terminal_manifest "$started_at"
emit_outputs
