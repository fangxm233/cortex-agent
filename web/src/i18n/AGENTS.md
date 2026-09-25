Please update me when files in this folder change.

Bilingual copy (en/zh) plus the language context. `foundation-not-to-app` forbids
importing `features/ mobile/ shell/` — the tables are data, imported by the app.

## How the vocab merges

`vocab.ts` is the composition root: it spreads every `*-vocab.ts` table plus the
base/extra tables into **one flat object per language**. There is no namespace and no
nesting — a key is a bare string (`settingsTitle`), so `useVocab()` returns a single flat
record. `type Vocab = typeof en`, and `zh` is typed `Record<keyof Vocab, string>`, so a key
present in `en` but missing from `zh` is a type error.

**Last write wins.** Two tables declaring the same key silently collide, and the spread
order in `vocab.ts` decides the winner — `enBase`, `pluginEn`, `enExtra`, `setupEn`,
`platformEn`, `updateCheckEn`, `uiAuthEn`, `windowActionsEn` (the zh order matches). The
type system does not catch it: the merged object simply carries the later value. New keys
get a distinctive prefix, and a rename means grepping all tables, not just one.

| filename | role | function |
|---|---|---|
| index.ts | entry | Barrel: `LangProvider`, `useLang` / `useSetLang` / `useVocab` / `useVocabOptional` / `useLangSource`, `pickVocab`, `resolveInitialLang`, `en` / `zh` / `Vocab` |
| vocab.ts | core | The composition root — merges every table into flat `en` / `zh` and derives the `Vocab` type |
| LangProvider.tsx | core | The language context, the cached initial value, and the sync seam the server sync plugs into |
| LangServerSync.tsx | core | Render-nothing component making the server the source of truth: reads `config.get`, writes `config.set` |
| lang.ts | core | `Lang` type, `pickVocab`, `resolveInitialLang`, and the local-storage cache of the server's choice |
| vocab-en-base.ts / vocab-zh-base.ts | type | The base table (~810 keys each), the bulk of the app's copy |
| vocab-en-extra.ts / vocab-zh-extra.ts | type | Overflow of the base table, split only to keep file size workable |
| plugins-vocab.ts | type | Plugin inventory, assignment and authoring copy |
| platform-settings-vocab.ts | type | Platform setup and runtime-settings copy |
| provider-setup-vocab.ts | type | Provider onboarding + appearance-control copy |
| update-check-vocab.ts | type | Manual update-check states and native reason codes |
| ui-auth-vocab.ts | type | Browser token-login and sign-out copy |
| window-actions-vocab.ts | type | Desktop window-action failure and fullscreen labels |
| `*.test.ts(x)` | test | vitest, colocated (`lang`, `LangServerSync`) |
