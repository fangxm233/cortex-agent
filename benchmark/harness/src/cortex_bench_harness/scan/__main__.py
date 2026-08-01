# input:  process arguments and scanner CLI main
# output: scanner module process exit status
# pos:    Python module entry point for artifact scanning
# >>> If I am updated, update my header and folder CORTEX.md <<<

from .cli import main

raise SystemExit(main())
