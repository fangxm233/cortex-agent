# core/locales/ — i18n message tables

Locale data consumed by `core/i18n.ts`'s `t(key, params)`. Zero-dependency leaf data (L0).

## Layout

| File | Role |
|------|------|
| `en.ts` | Barrel: aggregates all `slices/*` English objects into `en` and exports `MessageKey = keyof typeof en` (the canonical keyset). |
| `zh.ts` | Barrel: aggregates all `slices/*` Simplified-Chinese objects into `zh`, typed `Record<MessageKey, string>` — the compiler rejects any missing or extra key (parity enforcement). |
| `slices/` | One file per cluster, each exporting `<name>En` (`as const`) and `<name>Zh` (`Record<keyof typeof <name>En, string>`). Splitting by cluster keeps extraction work conflict-free. |

## Slices

`lang` (`!lang` command) · `status` (status/lifecycle prefixes + concise context-compaction notice + `btn.*` labels) · `commands` (all `!command` replies, help text) · `scheduling` (`!schedule` domain replies) · `interactions` (plan approvals, update prompt, modal/`interactive-builder` labels) · `startup` (startup-notify) · `init` (cortex init wizard + config output).

## Rules

- Keys are dot-namespaced by area (`cmd.cancel.*`, `status.*`, `init.*`, ...). Values may contain `${param}` placeholders resolved by `t()`.
- Icons (`core/icons.ts`) stay in CODE, never in these strings — only human-readable text lives here.
- When adding a key, add it to BOTH the En and Zh object of the same slice (the `Record<keyof typeof ...En>` type and the runtime parity test `tests/core/i18n.test.ts` both guard this).
- Logs are NOT localized — only user-facing messaging-platform/CLI text.
