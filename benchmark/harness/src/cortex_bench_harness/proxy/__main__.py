# input:  Python module command arguments
# output: trial proxy CLI exit status
# pos:    Python module command entry point
# >>> If I am updated, update my header and folder CORTEX.md <<<

from .cli import main

raise SystemExit(main())
