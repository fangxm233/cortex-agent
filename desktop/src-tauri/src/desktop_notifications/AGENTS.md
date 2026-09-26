Please update me when files in this folder change.

Native desktop notification delivery and process-lifetime click routing.

| filename | role | function |
|---|---|---|
| listener_tests.rs | test | Verify listener eviction and cancellation |
| mod.rs | entry | Register notification IPC and restore the window |
| platform.rs | adapter | Deliver notifications and receive native actions |
| queue.rs | core | Bound actions and filter connection snapshots |
| tests.rs | test | Verify routing, acknowledgement and privacy |
