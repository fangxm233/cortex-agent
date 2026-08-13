Update this file whenever this directory changes

Build scripts produce deterministic distribution artifacts; the mutation suite regenerates
capability evidence.

| filename | role | function |
|---|---|---|
| build-wheel.sh | build | Builds and byte-compares the fixed wheel |
| build-zero-paid-runtime-image.sh | build | Builds the pinned offline Node and PI runtime image |
| mutation-suite.py | evidence | Kills every listed mutation and regenerates offline evidence |
| provision-terminal-bench-images.sh | build | Provisions pinned Terminal-Bench task images |
| terminal-bench-2.1-images.json | config | Pins task sources, images and verifier inputs |
| zero-paid-runtime-inputs.json | config | Pins exact local Node, npm and PI build inputs |
