Please update me when files in this folder change

Regression tests for session-level orchestration helpers: agent file delivery,
assistant delta streaming, context compaction, and message rewind.

| filename | role | function |
|---|---|---|
| agent-file-send.test.ts | test | Covers agent file delivery and copying |
| delta-coalescer.test.ts | test | Covers reset-isolated delta stream gating |
| session-compact.test.ts | test | Covers manual context compaction outcomes |
| session-rewind.test.ts | test | Covers immutable restore and web turn rewind |
| session-send-rewind-race.test.ts | test | Covers send and rewind admission ordering |
