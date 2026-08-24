Update this file whenever this directory changes

Build scripts produce deterministic artifacts and versioned capability evidence, and the launch
script supplies the host references a campaign run needs. `bench` is the one command an operator
runs; the two scripts under it stay independently invocable and own every gate.

| filename | role | function |
|---|---|---|
| bench | launch | Runs bench-launch.py under the pinned offline harness environment |
| bench-launch.py | launch | Proves the declared subnets are free, rebuilds only stale trial artifacts, then preflights or runs the campaign detached |
| build-trial-artifacts.py | build | Builds both trial artifacts from current source into the paths a campaign pins, each with a provenance record |
| build-wheel.sh | build | Builds the fixed wheel at a pinned epoch |
| build-zero-paid-runtime-image.sh | build | Builds one pinned offline vendor runtime image |
| capture-pi-vendor-wire.py | evidence | Captures PI loopback wire evidence |
| capability-evidence-v1-to-v2.json | config | Pins v1 evidence inputs and the v2 field migration |
| launch-paid-campaign.py | launch | Loads host credentials and launches paid campaigns |
| launch-terminal-bench-pi-full.py | launch | Runs the isolated 89-task PI full suite |
| migrate-capability-evidence.py | evidence | Reproduces canonical v2 evidence and digests |
| mutation-suite.py | evidence | Kills every listed mutation and regenerates offline evidence |
| provision-terminal-bench-images.sh | build | Provisions role-safe vendor and Cortex-smoke images |
| terminal-bench-2.1-images.json | config | Pins task sources, runtime variants and verifier inputs |
| vendor-runtime-preflight.js | verify | Exercises one isolated CLI against loopback synthetic upstream |
| zero-paid-runtime-inputs.json | config | Pins exact Node, npm and three vendor build inputs |
