Please update me when files in this folder change

Bilingual copy layer: one vocabulary object per language plus the hooks that read the active choice.
Language is persisted in local storage and falls back to the browser preference.

| filename | role | function |
|---|---|---|
| index.ts | barrel | Re-exports language hooks, helpers and vocab |
| LangProvider.tsx | provider | Holds active language and exposes vocab hooks |
| lang.ts | util | Resolves, persists and maps the language choice |
| lang.test.ts | test | Unit tests for language derivation and vocab pick |
| vocab.ts | types | Bilingual product, task-scope and hook copy |
