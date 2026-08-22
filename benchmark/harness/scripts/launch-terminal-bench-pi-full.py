#!/usr/bin/env python3
# input:  explicit full-suite host paths and committed external-suite spec
# output: structured preflight or per-task-proxy PI suite execution
# pos:    Full Terminal-Bench PI launch wrapper
# >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

from cortex_bench_harness.full_suite.cli import main


if __name__ == "__main__":
    raise SystemExit(main())
