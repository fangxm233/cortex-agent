Please update me when files in this folder change

Message tables backing the i18n layer: every user-facing string in English and Simplified Chinese.

The active locale is PROCESS-GLOBAL (`core/i18n.ts`), sourced from `config/preferences.json` → `lang`
(or `CORTEX_LANG`, which wins at boot). That one value is also what the Web UI renders its own
vocabulary in — the SPA reads it from `config.get` — so the interface and the conversation never
disagree. Deliberately NOT per-session or per-channel: making `t()` locale-aware would mean
threading a locale through several hundred call sites to buy a "Slack in Chinese, Web in English"
split that a single-operator install has no use for.

| filename | role | function |
|---|---|---|
| en.ts | barrel | aggregates English slices and the key type |
| zh.ts | barrel | aggregates Simplified Chinese slices |
| slices/ | subdir | per-area English and Chinese message sets |
