Please update me when files in this folder change

Bilingual copy layer: split chunks plus a small merge root.

The language is NOT a per-device preference. It is one server setting
(`config/preferences.json` → `lang`, same knob as `!lang`), because it also decides the language
Cortex writes in the conversation — auto-compaction notices, command replies, status lines all
render through the server's `t()`. Two independent knobs is how an English UI ends up printing
"上下文已自动压缩。". Local storage only caches the last known value for first paint and keeps the
toggle usable while the server is unreachable; `config.get` overwrites it as soon as it lands.

| filename | role | function |
|---|---|---|
| index.ts | barrel | Re-exports hooks and vocab tables |
| LangProvider.tsx | provider | Holds active language state and the write-through seam |
| LangServerSync.tsx | sync | Adopts the server's language and writes toggles back to it |
| LangServerSync.test.tsx | test | Covers server-over-cache, write-through, rollback, offline |
| lang.ts | util | Resolves language and caches it for first paint |
| lang.test.ts | test | Covers viewport derivation, breakpoint handling and the cache |
| vocab.ts | entry | Composes bilingual UI and update-check vocabulary |
| window-actions-vocab.ts | copy | Bilingual native window feedback |
| update-check-vocab.ts | copy | Defines manual update statuses and reason copy |
| provider-setup-vocab.ts | copy | Provider setup and appearance-control copy |
| plugins-vocab.ts | copy | Defines plugin settings and scope copy |
| vocab-en-base.ts | copy | English core, About, status and slash feedback copy |
| vocab-en-extra.ts | copy | English product and device notification copy |
| vocab-zh-base.ts | copy | Chinese core, About, status and slash feedback copy |
| vocab-zh-extra.ts | copy | Chinese product and device notification copy |
| platform-settings-vocab.ts | copy | Defines bilingual platform configuration copy |
