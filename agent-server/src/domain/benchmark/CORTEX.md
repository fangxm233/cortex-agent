Please update me when files in this folder change

Production benchmark evidence projection and publication.

| filename | role | function |
|---|---|---|
| accounting-reconciliation.ts | core | Records proxy and journal usage |
| atif.ts | format | Builds recursive ATIF trajectories |
| attempt-record.ts | types | Defines attempts and durable edges |
| composite-manifest.ts | core | Builds and publishes composite evidence |
| decimal-text.ts | util | Parses exact decimal values |
| identity.ts | core | Hashes model, role and launcher identities |
| journal.ts | core | Writes ordered production attempt journals |
| manifest-contract.ts | types | Defines terminal lifecycle evidence |
| production-attempt-identity.ts | identity | Persists production spawn identities |
| production-attempt-journal.ts | journal | Persists normalized attempt journals |
| production-evidence-export.ts | core | Publishes production evidence atomically |
| production-evidence-journal.ts | core | Parses production attempt journals |
| production-evidence-projection.ts | core | Projects production stores into evidence |
| production-evidence-topology.ts | core | Projects durable attempt topology |
| role-surface.ts | identity | Resolves production role capability surfaces |

The identity/journal/role-surface files were under `domain/runs/observers/` and were read as run
observers. They are not: they are this schema, and their only readers are the projection and export
code beside them plus `attempt.ts`'s journal sink (`createProductionAttemptJournalSink`), which is
where a run hands its raw event tap over. Keeping them here removes the `observers/ <-> benchmark/`
round trip; the one thing that stayed there is `resume-recorder.ts`, which really is a policy a run
subscribes to.

An incomplete run is not a malformed one. Three checks here used to demand the happy path and
refuse everything else, and because the harness turns an export refusal into a trial abort *before
the verifier runs*, each refusal cost a benchmark trial the score it had already earned — sixteen
of them on 2026-08-27. A role with no attempt is now accepted when the thread ended `failed`,
`cancelled` or `aborted`, because a coder cut off at its wall clock or refused by the vendor never
had a reviewer to record; a role missing from a thread that ran to `completed` is still a defect
and still refused. A `dispatch` fact whose thread never froze an attempt now projects no edge
rather than failing, because `task -> attempt` has no endpoint to point at; the fact itself stays
in the collected topology ledger, so the dispatch remains on the record.

What replaced the refusals is not silence: each attempt carries its own `terminal_state` and
`terminal_reason`, so a stopped pipeline publishes exactly the roles that ran, each labelled with
how it ended.
