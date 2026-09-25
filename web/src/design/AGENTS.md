Please update me when files in this folder change.

The primitive kit, shared by both chromes and app-free: it names no feature at runtime.
`foundation-not-to-app` forbids importing `features/ mobile/ shell/`. `index.ts` is the
barrel every consumer imports from (`@/design`); a few modules are imported by path.

## Primitives

| filename | role | function |
|---|---|---|
| index.ts | entry | Public barrel — primitives, overlays, toast, tone/degraded tokens |
| Button.tsx | core | Token-driven variants/sizes, ref-forwarding so it can be a Radix `asChild` trigger |
| Card.tsx | core | Surface card + `CardHeader` / `CardBody`: unblurred glass or opaque reading material |
| SectionHeader.tsx | core | Title + mono count + right-aligned actions + optional description |
| StatusPill.tsx | core | Status pill, bg/fg picked from the `pill-<tone>` tokens |
| MonoText.tsx | core | Monospace primitive for data values, ids, counts |
| ID.tsx | core | Short id chip with copy affordance |
| PlusGlyph.tsx | core | The ＋ mark drawn as two strokes (the text glyph is off-centre and hairline at button sizes) |
| EmptyState.tsx | core | Centered empty card: title, description, optional action |
| DegradedState.tsx | core | Degraded/exception card in the unified amber/red/blue language |
| degraded.ts | type | `DEGRADED_SEVERITIES` + `severityTone` — the four degraded variants onto three tones |
| tone.ts | type | `TONES` / `statusTone` — the status colour vocabulary |
| controls.ts | type | `CONTROL_HEIGHT`, so a select + input + button read as one control strip |

## Overlays and feedback

| filename | role | function |
|---|---|---|
| Modal.tsx | core | Radix Dialog wrapper: focus trap, esc, aria-modal, scroll lock; `standard` and `bare` chrome |
| Drawer.tsx | core | Side sheet on the same Radix Dialog guarantees, left/right anchored |
| Popover.tsx | core | Radix Popover on the shared glass overlay material, controlled or uncontrolled |
| Select.tsx | core | Radix Select: stable control + glass option overlay; row sizing lives on the Item (ItemText strips className) |
| Tabs.tsx | core | Radix Tabs, both data-driven (`Tabs`) and as styled parts |
| Tooltip.tsx | core | Radix Tooltip + the `TooltipProvider` mounted once at the root |
| BottomSheet.tsx | core | **In design/ because both chromes use it**: mobile screens compose it through `mobile/ui/kit`, and shared features (login, rate limit) render it on a narrow viewport. Portals through `mobile-overlay-host` |
| mobile-overlay-host.tsx | core | `MobileOverlayHost` / `MobileOverlayPortal`: the layer MobileShell mounts so sheets rise above the floating tab bar; renders in place when no host exists |
| use-back-dismiss.ts | core | Android/browser back dismisses the top overlay instead of navigating the router |
| Toast.tsx | core | `ToastProvider` — the app's single bubble queue, mounted once near the root |
| ToastViewport.tsx | core | The desktop bubble stack: the ONE renderer for imperative toasts and the live notification feed |
| toast-store.ts | core | Pure, DOM-free queue logic behind both (add/remove, visible split, relative age) |
| DesktopUpdateFrame.tsx | core | The shared chrome an update dialog renders into |
| useClipboardFeedback.ts | utility | Copy-to-clipboard with the "copied" flash state |

## Seams and shared renderers

| filename | role | function |
|---|---|---|
| modal-registry.tsx | core | **Below every feature so all can use it**: one `useSyncExternalStore` `Map<kind,payload>`; `defineModal<T>(kind)` per overlay, one host renders it |
| dock-intake.tsx | core | **Below every feature for the same reason**: the seam a surface hands a preview across to reach the dock, so `features/media` need not import `features/dock` |
| ChatMarkdown.tsx | core | Text in, JSX out, over the parser in `lib/markdown.ts`; code blocks carry a hover copy button. **In design/** — both chromes render transcripts, so it cannot sit inside one |
| mobile-tokens.ts | type | The `MC` (colour) / `MONO` tables and floating-chrome edges (`M_FLOAT_TOP`, `M_TABBAR_BOTTOM`). **In design/** so shared primitives and mobile screens read one table |
| MenuChrome.tsx | core | Glass picker shells (`MenuCard`, `MenuRow`, `MENU_SURFACE`, `MENU_FOCUS`, …) shared by the session transcript and the workbench composer/rail menus |
| content-surfaces.css | style | The dense content-surface language (focus rings, text actions, overview layout) imported by ~15 features; **in design/** so sharing it creates no feature pair |
| `*.test.ts(x)` | test | vitest, colocated (BottomSheet, ChatMarkdown, Modal, modal-registry, presentation, Select, toast-store, ToastViewport, use-back-dismiss) |
