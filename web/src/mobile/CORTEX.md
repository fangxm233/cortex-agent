Please update me when files in this folder change

The mobile surface: its own router, four-tab shell and route-transition chrome, separate from desktop.
This level holds the shell frame, the tab and route model, and the pure cross-screen logic.

| filename | role | function |
|---|---|---|
| mobile-router.tsx | entry | Builds the browser or hash router instance |
| mobile-routes.tsx | entry | Declares tab, account and other drill-in routes |
| MobileShell.tsx | core | Frames providers, outlet, native back and tabs |
| MobileAnimatedOutlet.tsx | core | Animates routes and retains the source tab frame |
| MobileAnimatedOutlet.test.tsx | test | Tests transitions and retained tab frames |
| BottomTabBar.tsx | view | Four-tab bottom bar with icons and badges |
| mobile-navigation.ts | core | Applies semantic back and settings parent navigation |
| mobile-navigation.test.ts | test | Tests mobile back and tab-switch policy |
| mobile-tabs.ts | core | Maps paths to active tab and badge counts |
| mobile-tabs.test.ts | test | Unit tests for path to tab mapping |
| mobile-tasks.ts | core | Groups tasks into six lifecycle sections |
| mobile-tasks.test.ts | test | Tests mobile lifecycle classification |
| current-project.tsx | provider | Shares the mobile-wide project selection |
| use-back-dismiss.ts | hook | Makes hardware back close overlays not routes |
| use-back-dismiss.test.ts | test | Unit tests for the back dismiss guard |
| use-viewport-height.ts | hook | Publishes keyboard-aware viewport size |
| use-viewport-height.test.ts | test | Unit tests for viewport height mirroring |
| v3/ | subdir | All mobile screens as screen, view and model |
| ui/ | subdir | Shared mobile kit and formatters |
| screens/ | subdir | Pure view models reused by the v3 screens |
