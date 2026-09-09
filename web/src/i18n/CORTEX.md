Please update me when files in this folder change

Bilingual copy layer: split chunks plus a small merge root.
Language stays in local storage and falls back to browser choice.

| filename | role | function |
|---|---|---|
| index.ts | barrel | Re-exports hooks and vocab tables |
| LangProvider.tsx | provider | Holds active language state |
| lang.ts | util | Resolves and persists language choice |
| lang.test.ts | test | Covers viewport language derivation and breakpoint handling |
| vocab.ts | entry | Composes bilingual UI and update-check vocabulary |
| update-check-vocab.ts | copy | Defines manual update statuses and reason copy |
| provider-setup-vocab.ts | copy | Provider setup and appearance-control copy |
| plugins-vocab.ts | copy | Defines plugin settings and scope copy |
| vocab-en-base.ts | copy | English core, status and slash feedback copy |
| vocab-en-extra.ts | copy | English product and device notification copy |
| vocab-zh-base.ts | copy | Chinese core, status and slash feedback copy |
| vocab-zh-extra.ts | copy | Chinese product and device notification copy |
| platform-settings-vocab.ts | copy | Defines bilingual platform configuration copy |
