Please update me when files in this folder change.

The mobile chrome. `mobile-only-from-router` means only `router.tsx`, `RootRouter.tsx`
and `responsive-route.tsx` may import this tree from outside, and `features-not-to-mobile`
means no feature may import it — so the whole directory stays movable as a unit. It
imports `features/`, `design/`, `theme/`, `i18n/` and `lib/` freely, plus
`shell/ShellProviders` (the shared provider set, mounted by each chrome).

## Root

| filename | role | function |
|---|---|---|
| MobileShell.tsx | entry | The chrome: `MobileProviders` (ShellProviders + `MNotificationMount` + `MUpdateMount`), the overlay host, animated outlet, floating tab bar and the `--m-tabbar-*` clearance it publishes |
| mobile-routes.tsx | core | The route objects the root router splices in, each wrapped in `ResponsiveRoute mobile` |
| mobile-route-manifest.ts | core | Route id ↔ path manifest; `matchMobileRoute` / `mobileRoutePath`, used by `responsive-route.tsx` to translate across chromes |
| mobile-navigation.ts | core | Tab switching and the hardware/browser back stack |
| mobile-tabs.ts | core | Which tab a path belongs to (`activeTabId`, `isTabRoute`) |
| BottomTabBar.tsx | core | The floating glass tab bar with readable alert counts |
| MobileAnimatedOutlet.tsx | core | Push/pop transition around the routed screen |
| use-viewport-height.ts | utility | Real viewport height on mobile browsers (URL bar / keyboard insets) |
| `*.test.ts(x)` | test | vitest, colocated (mobile-navigation, mobile-route-manifest, mobile-routes, mobile-tabs, MobileAnimatedOutlet, use-viewport-height) |

## Sub-directories

| dir | what goes there | index |
|---|---|---|
| `screens/` | Every routed mobile screen: `M*Screen` containers, `M*View` presentations, `m-*-vm` models | `screens/AGENTS.md` |
| `shared/` | View-models and widgets more than one screen uses (session, machines, thread stepper) | `shared/AGENTS.md` |
| `ui/` | The mobile kit: `MScreen`, headers, cards, pills, composer, formatting | `ui/AGENTS.md` |

Shared primitives the mobile kit re-exports (`MBottomSheet`, `MC`/`MONO` tokens, the overlay
host) live in `design/`, because features render them too.
