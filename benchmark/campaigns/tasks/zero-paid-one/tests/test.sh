#!/bin/sh
test "$(cat /tmp/answer.txt 2>/dev/null)" = "one"
