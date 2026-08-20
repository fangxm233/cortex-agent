Update this file whenever this directory changes

Codex fixtures preserve the historical wire and pin the current native CLI contract.

| filename | role | function |
|---|---|---|
| capture.py | probe | Captures native Codex traffic in an isolated network |
| contract.json | fixture | Records the historical pin, auth, wire, expiry, and containment facts |
| current-contract.json | fixture | Records the current pin, model, native-default wire, and doctor probes |
| request-body.json | fixture | Records the normalized observed request body |
| success-sse.json | fixture | Replays the accepted complete SSE sequence |
