Please update me when files in this folder change

Session domain for agent conversations: session records, name registry, transcript backup, hooks.
Distinct from the terminal UI session layer that lives in tui-session.

| filename | role | function |
|---|---|---|
| session.ts | adapter | channel session create, read and delete |
| session-registry.ts | adapter | maps short session names to session ids |
| session-backup.ts | util | snapshots and restores recorded transcript paths |
| session-hooks.ts | core | dispatches session hooks, diagnostics and injection |
| session-lifecycle.ts | core | registers, attaches, adopts and resets sessions |
