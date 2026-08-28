Please update me when files in this folder change.

Neutral project lifecycle infrastructure shared unchanged by desktop and mobile.
Selection has one resolver/context, while creation has one validator, error mapper, and mutation controller.
No desktop or mobile feature may wrap, alias, or duplicate these exports.

| filename | role | function |
|---|---|---|
| CurrentProjectProvider.tsx | provider | Shares effective selection, listed projects and shell order |
| CurrentProjectProvider.test.tsx | test | Verifies project listing, selection and rendered order updates |
| useProjectSessions.ts | hook | Reuses unscoped origin caches and selects project sessions for both surfaces |
| useProjectSessions.test.ts | test | Tests shared session project projection |
| current-project.ts | model | Resolves latest-session, first-project, and explicit project ids |
| current-project.test.ts | test | Tests shared project id derivation rules |
| new-project.ts | model | Validates names and preserves backend creation errors |
| new-project.test.ts | test | Tests shared project validation and error mapping |
| useCreateProject.ts | controller | Creates projects, invalidates the list, and returns the created id |
| useCreateProject.test.tsx | test | Tests validation, invalidation, returned ids, and errors |
