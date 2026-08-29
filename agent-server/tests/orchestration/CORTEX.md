Please update me when files in this folder change

Regression tests for session-level orchestration helpers: agent file delivery,
assistant delta streaming, context compaction, and message rewind.

| filename | role | function |
|---|---|---|
| agent-file-send.test.ts | test | Covers file delivery, copying and Unicode names |
| agent-view-send.test.ts | test | Covers view delivery, the view bucket, limits and naming |
| agent-decision-send.test.ts | test | Covers decision recording, ids, limits, commission projection |
| delta-coalescer.test.ts | test | Covers reset-isolated delta stream gating |
| session-compact.test.ts | test | Covers manual context compaction outcomes |
| session-rewind.test.ts | test | Covers PI restore identity and Web rewind |
| session-send-rewind-race.test.ts | test | Covers send and rewind admission ordering |
