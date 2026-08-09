Please update me when files in this folder change

Bilingual copy layer: split chunks plus a small merge root.
Language stays in local storage and falls back to browser choice.

| filename | role | function |
|---|---|---|
| index.ts | barrel | Re-exports hooks and vocab tables |
| LangProvider.tsx | provider | Holds active language state |
| lang.ts | util | Resolves and persists language choice |
| lang.test.ts | test | Covers language derivation and copy |
| vocab.ts | compose | Merges split chunks into en and zh |
| plugins-vocab.ts | copy | Holds plugin and stale-draft copy |
| vocab-en-base.ts | copy | English chunk before plugin copy |
| vocab-en-extra.ts | copy | English chunk after plugin copy |
| vocab-zh-base.ts | copy | Chinese chunk before plugin copy |
| vocab-zh-extra.ts | copy | Chinese chunk after plugin copy |
