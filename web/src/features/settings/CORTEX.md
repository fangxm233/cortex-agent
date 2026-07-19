# features/settings/ — Settings modal 12a–g (Stage-R2+)

The **Settings modal** overlay, rebuilt **1:1** from `design/ref/prototype.dc.html` L721–1088 (script
L2379–2797) and diffed vs `design/proto-shots/14-settings.png` (plan §8.5 settings row). A 1080×680
centered Radix-Dialog card: 48px header + **210px left nav (10 panels)** + `var(--proto-alt)` content area.

The first nav entry is **Appearance** (`AppearancePanel.tsx`) — the two device-local settings:
interface **language** (EN/中, `src/i18n` `useLang`/`useSetLang`, localStorage `cortex.lang`) and the
light/dark **theme** (`src/theme` `useTheme`/`useSetTheme`, localStorage `cortex.theme`). Both are
ink-solid segmented toggles; no `config.get`/`config.set`, so the panel renders even if the config
query is loading/errored. The remaining 9 panels are below.
Wired to the **real** `config.get` query (redacted `~/.cortex/config` snapshot) for every panel; the
**Budget** panel drives a real `config.set` write. Consumes the config contract shipped by task 0837.

| path | role |
|---|---|
| `settings-nav.ts` | **Pure** (TDD): the 10 nav entries — `appearance` first, then the 9 prototype panels (label/file/key, prototype order) + `SETTINGS_SECTION_META` (title/sub). |
| `AppearancePanel.tsx` | Device-local **language** (EN/中 over `src/i18n` `useLang`/`useSetLang`) + **light/dark theme** (over `src/theme` `useTheme`/`useSetTheme`) toggles — both ink-solid segmented chips via a shared `Segmented` helper. No backend — persisted to localStorage `cortex.lang` / `cortex.theme`. The language switch moved here from the left-rail footer (which now hosts the theme toggle). |
| `settings-nav.test.ts` | vitest — nav order, labels/file tags, section meta. |
| `platform-env.ts` | **Pure** (TDD): redacted `.env` helpers — `indexEnv`/`envRow` (present→mask `••••••••`, absent→`—`, **never cleartext**), `envKeysWithPrefix`/`hasAnyKey`, and the prototype key groups (SLACK/FEISHU/API/DAEMON, notify + advanced flags). |
| `platform-env.test.ts` | vitest — index, row masking (no cleartext), prefix filter, presence. |
| `budget-vm.ts` | **Pure** (TDD, governs the ONLY write): `DAILY_CHIPS`/`WARN_CHIPS`, `isDailyChipActive`, `buildBudgetValue` (preserves monthly_usd; returns null when it cannot satisfy the backend zod contract — never fabricates a monthly), `formatBudgetUsd`, `budgetBarPct`. |
| `budget-vm.test.ts` | vitest — chip active, value-builder (incl. null/non-positive monthly → null), formatting, bar pct. |
| `settings-ui.tsx` | Shared 1:1 chrome: `SCard`/`SCardHeader`/`MonoKV`/`Toggle`/`RadioDot`. Raw inline styles/px/hex per §8.3. |
| `SettingsPanels.tsx` | The 8 presentational panels (Platform/Profiles/Machines/Templates/MCP/Notifications/Hooks/Advanced) — prototype-exact structure with real snapshot data + honest placeholders. **Optional action handlers** (b983): `ProfilesPanel.onSetDefaultProfile` (real config.set `profiles` write via a native `<select>`), `PlatformPanel.onReconnect` + `MachinesPanel.onAddMachine` (high-privilege → `approvals.request` gate). Panels stay PURE — omitting a handler renders the inert placeholder, so the render test needs no tRPC provider. |
| `settings-render.test.tsx` | vitest `react-dom/server` render checks for the 8 panels (real data + placeholders, no cleartext leak) + the b983 wired affordances (default-profile select, approval-gated Reconnect/Add-machine buttons; inert without a handler). |
| `BudgetPanel.tsx` | Budget panel 12c — **live write**: DAILY chip → `config.set(budget)` mutation → invalidate `config.get` (change→read-back). WARN AT + over-budget policy inert (no budget.json field). today/month from `cost.summary`; daily/monthly denominators from budget.json. |
| `SettingsModal.tsx` | Radix Dialog shell (backdrop scrim + `cxmodal` anim + focus-trap/Esc) + header + 210px nav + content; binds `config.get` + `cost.summary`, switches the 9 panels client-side. **Owns the b983 action wiring** (the panels are pure): a `config.set` `profiles` mutation (→ invalidate `config.get`) and an `approvals.request` mutation, threaded to Profiles / Platform / Machines as `onSetDefaultProfile` / `onReconnect` / `onAddMachine`. |
| `SettingsRoute.tsx` | Route `/settings` = `<WorkbenchPage/>` behind + `<SettingsModal open onClose→/workbench/>` (prototype `modal:'settings'` over a dimmed workbench). LeftRail Settings + ⌘K Settings both already navigate here. |

## Real data vs honest placeholders (no fabricated numbers)

- **REAL**: Platform env keys (grouped, present✓/masked/absent—); Profiles defaultProfile + rows
  (name/model/backend/mode/thinking) + **live config.set `profiles` write** (default-profile select, b983);
  **Budget** daily/monthly (budget.json) + today/month (cost.summary) + **live config.set write**;
  Machines name/cortexPath/gpuCount/ssh-presence/os; Templates real basenames (templates/agents/
  shells); MCP real server names; Notifications/Advanced toggles reflect real env presence; Hooks
  real filenames.
- **APPROVAL-GATED (b983)**: Reconnect (Slack/飞书) and Add-machine are high-privilege — they NEVER
  bare-execute; clicking queues an `approvals.request` PENDING entry for the Approval Center. The
  underlying operation is actioned by a human/agent after approval (the mutate never runs it).
- **SECURITY**: `.env` values are never rendered (only the fixed mask + present flag); machine `ssh`
  is a presence flag, not the raw user@host — enforced by the config.get contract and never bypassed.
- **Inert / structural placeholder** (backend-uncovered, flagged): Restart-daemon/envDirty (no env
  write → banner omitted, no fabricated pending count), TUI + notify + advanced toggles (no safe env
  write path — `.env` holds secrets), **WARN AT + over-budget radio (no warn/policy field in
  budget.json and no cost-tracker consumer — a write would fabricate a capability, so deferred)**,
  Logs/Retry, runtime CLIENT/STATUS/heartbeat, Open-editor, MCP variant + tool chips, per-template
  chips/hooks, per-hook matcher/phase. Client-lifecycle / Connectivity / thread-lifecycle cards are
  static architecture notes.

## Notes

- **Backend contract** — `config.get` + `cost.summary` (read) and `config.set` (write, now with a
  `budget` AND a `profiles` section) + `approvals.request` (b983 enqueue gate). The config.set
  `profiles` section and the `approvals.request` op were added server-side for b983 (see
  `agent-server/src/domain/ui-service/mutate/{config,approvals}.ts`).
- The Profiles + Notifications panels carry a few literal-Chinese notes that are hardcoded in the
  prototype source (not language-toggled); reproduced verbatim for 1:1 fidelity (§8.3). All other
  copy is the prototype's EN.
- Verified: `pnpm -w build` (non-desktop) + web `tsc --noEmit` EXIT=0; web `vitest` 238/238. Live
  (isolated `CORTEX_HOME`): real config.get render across all 9 panels + Budget config.set write
  reflected on read-back. Side-by-side vs `14-settings.png` → `design/build-shots/09e3-settings-compare.png`.
