#!/bin/sh
# input:  Claude print-mode argv and one stream-json user message
# output: pinned version, assistant/result stream, and invocation artifacts
# pos:    Network-free Claude CLI substitute for container integration
# >>> If I am updated, update my header and folder CORTEX.md <<<

set -eu

ARTIFACT_DIR=${FAKE_CLAUDE_ARTIFACT_DIR:?}
VERSION='2.1.999 (Cortex benchmark fake)'

if [ "${1:-}" = "--version" ]; then
  printf '%s\n' "$VERSION" | tee "$ARTIFACT_DIR/fake-claude-version.txt"
  exit 0
fi

printf '%s\n' "$@" > "$ARTIFACT_DIR/fake-claude-argv.txt"
pwd > "$ARTIFACT_DIR/fake-claude-cwd.txt"
IFS= read -r request
printf '%s\n' "$request" > "$ARTIFACT_DIR/fake-claude-stdin.json"
session_id=$(printf '%s\n' "$request" | sed -n 's/.*"session_id":"\([^"]*\)".*/\1/p')
test -n "$session_id"

assistant='{"type":"assistant","message":{"id":"fake-message-1","model":"claude-fake-benchmark","content":[{"type":"text","text":"fake backend completed"}],"usage":{"input_tokens":11,"output_tokens":7,"cache_creation_input_tokens":3,"cache_read_input_tokens":5}}}'
result=$(printf '{"type":"result","subtype":"success","is_error":false,"session_id":"%s","result":"fake backend completed","total_cost_usd":0.001,"num_turns":1,"usage":{"input_tokens":11,"output_tokens":7,"cache_creation_input_tokens":3,"cache_read_input_tokens":5},"modelUsage":{"claude-fake-benchmark":{}}}' "$session_id")
printf '%s\n%s\n' "$assistant" "$result" | tee "$ARTIFACT_DIR/fake-claude-output.jsonl"
