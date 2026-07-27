# design/ — token-driven core primitives (design §5, Stage 2)

The design-system primitive library. Every functional screen composes from these
instead of hard-coding styles. **All** colors/spacing/radius/shadow/fonts come from
`web/tailwind.config.ts` tokens — no primitive contains a hex literal.

| path | role |
|---|---|
| `tone.ts` | Pure `statusTone(status) → Tone` mapping the contract status vocabularies (thread `running/waiting/completed/failed/cancelled/aborted`, task `open/done`, execution `…/stale`) onto the 5 pill tones. `TONES` canonical list. Unknown → `cancelled`. |
| `tone.test.ts` | vitest unit test for `statusTone` (TDD — written first). |
| `StatusPill.tsx` | `StatusPill` — pill from a `tone` or a `status` (auto-mapped via `statusTone`). `pill-<tone>-{bg,fg}` tokens. |
| `MonoText.tsx` | `MonoText` — IBM Plex Mono (`font-mono`) data text; `muted` variant. |
| `ID.tsx` | `ID` — identifier in mono; `copyable` → click-to-copy with transient ✓. |
| `Card.tsx` | `Card` (+ `CardHeader`, `CardBody`) — white surface, token border/radius/shadow; `padded`. |
| `SectionHeader.tsx` | `SectionHeader` — title + optional mono count + right-aligned actions + description. |
| `Button.tsx` | `Button` — variants `primary/secondary/ghost/danger` × sizes `sm/md`; token colors, focus ring, disabled. **`forwardRef`** so it can be an `asChild` Radix trigger (Dialog/Popover restore focus to the trigger via its ref). |
| `Tabs.tsx` | `Tabs` (data-driven) + parts `TabsRoot/TabsList/Tab/TabPanel` — token-styled Radix Tabs. |
| `Tooltip.tsx` | `Tooltip` + `TooltipProvider` (mount once in `providers.tsx`) — token-styled Radix Tooltip. |
| `EmptyState.tsx` | `EmptyState` — centered card, muted title/description, optional icon/action (design 10d). |
| `degraded.ts` | Pure `severityTone(severity) → Tone` mapping the 3 degraded severities onto pill tones. `DEGRADED_SEVERITIES` canonical list. Color-language invariant: amber `waiting`, red `human`→failed, blue `info`→running. |
| `degraded.test.ts` | vitest unit test for `severityTone` (TDD — written first). |
| `DegradedState.tsx` | `DegradedState` — exception/degraded card (design 10c): severity-tinted header (dot + title + mono meta) + body (detail/children/actions). Tokens only via `pill-<tone>-{bg,fg}` / `state-{run,wait,fail}`; `pulse` for live dot. |
| `Modal.tsx` | `Modal` (+ `ModalClose`) — token-styled Radix **Dialog**: centered default/wide card, overlay fade + content zoom in/out. Focus trap, Esc-close, focus-restore, aria-modal from Radix. Controlled (`open`/`onOpenChange`) or uncontrolled (`trigger`); requires a `title` (`hideTitle` → sr-only). |
| `Drawer.tsx` | `Drawer` (+ `DrawerClose`) — side sheet on Radix Dialog; `side` `right`(default)`/left` with matching slide in/out. Same Dialog a11y as Modal. |
| `Popover.tsx` | `Popover` (+ `PopoverClose`) — token-styled Radix **Popover**: positioned floating panel, fade/scale in-out, arrow. Esc-close + focus-return from Radix. |
| `Toast.tsx` | `ToastProvider` (mount once in `providers.tsx`) + imperative `useToast()` hook (`toast()`/`dismiss()`) on Radix **Toast**. Tone accent from pill tokens; slide/fade enter-exit; role/announce/swipe/hotkey a11y from Radix. Optional `actions: ToastAction[]` render as token-styled buttons under the description (Radix `Toast.Action`, dismisses on click) — used by the desktop download-complete toast's Open file / Open folder. |
| `toast-store.ts` | Pure toast-queue logic (`addToast`/`removeToast`/`MAX_TOASTS`) + `ToastItem`/`ToastAction` types — framework-agnostic, unit-tested; the hook owns id/timers and delegates here. |
| `toast-store.test.ts` | vitest unit test for the queue reducer (TDD — written first). |
| `index.ts` | Barrel — public exports for all primitives + `Tone`/`statusTone`/`TONES` + `DegradedState`/`severityTone`/`DEGRADED_SEVERITIES` + Modal/Drawer/Popover/Toast. |

## Notes

- Demo surface: `web/src/features/kit/KitPage.tsx` → route `/kit` renders every primitive in
  every variant/state (pure presentational, no agent-server needed). The Overlays group has live
  triggers for Modal/Drawer/Toast/Popover.
- Tabs/Tooltip/Modal/Drawer/Popover/Toast wrap `@radix-ui/react-{tabs,tooltip,dialog,popover,toast}`
  (approved primitive layer, design §1) for keyboard/a11y/positioning; styling is token-only.
- **Overlay motion** lives as `keyframes`/`animation` tokens in `tailwind.config.ts` (no extra dep),
  driven off Radix `data-[state=open|closed]`; each overlay carries `motion-reduce:animate-none`.
- `features/tasks/Pills.tsx` and `shell/EmptyPane` now delegate to `StatusPill` / `EmptyState`
  — one source of truth, appearance preserved.
- Status language 10c/10d (task 2add): `DegradedState` + the 3-severity `degraded.ts` map power the
  four degraded variants; `EmptyState` powers the 10d next-action panels. Both demoed at `/kit`
  (`features/kit/DegradedDemos.tsx` + KitPage sections). No real-data consumer yet (Machines/threads/
  budget wiring are Stage 3/5/7) — `/kit` is the current consumer.
