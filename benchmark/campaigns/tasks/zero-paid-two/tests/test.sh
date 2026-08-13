#!/bin/sh
set -eu
if test "$(cat /tmp/answer.txt 2>/dev/null)" = "two"; then
  printf '1\n' > /logs/verifier/reward.txt
else
  printf '0\n' > /logs/verifier/reward.txt
fi
