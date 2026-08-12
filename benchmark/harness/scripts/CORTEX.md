Update this file whenever this directory changes

Build scripts produce deterministic distribution artifacts; the mutation suite regenerates
capability evidence.

| filename | role | function |
|---|---|---|
| build-wheel.sh | build | Builds and byte-compares the fixed wheel |
| mutation-suite.py | evidence | Kills every listed mutation and regenerates offline evidence |
