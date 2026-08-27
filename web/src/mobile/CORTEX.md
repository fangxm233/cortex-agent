Please update me when files in this folder change

The mobile surface: its own router, four-tab shell and route-transition chrome, separate from desktop.
This level holds the shell frame, tab/route model and mobile-only cross-screen logic.
Tasks, issues, attachments, hook namespaces and status tones consume canonical feature/design models instead of local copies.
Android back handling consumes the canonical typed native bridge, including race-safe idempotent teardown.

| filename | role | function |
|---|---|---|
| mobile-router.tsx | entry | Builds the browser or hash router instance |
| mobile-routes.tsx | entry | Declares tab and canonical settings drill-in routes |
| mobile-routes.test.tsx | test | Verifies supported and desktop-only settings routes |
| MobileShell.tsx | core | Frames the shared project provider, outlet, native back and tabs |
| MobileAnimatedOutlet.tsx | core | Animates routes and retains the source tab frame |
| MobileAnimatedOutlet.test.tsx | test | Tests transitions and retained tab frames |
| BottomTabBar.tsx | view | Four-tab bottom bar with icons and badges |
| mobile-navigation.ts | core | Applies semantic back and delegates unknown native back payloads to the canonical bridge |
| mobile-navigation.test.ts | test | Tests settings parents, Router-history policy and tab switching |
| mobile-tabs.ts | core | Maps paths to active tab and badge counts |
| mobile-tabs.test.ts | test | Unit tests for path to tab mapping |
| use-back-dismiss.ts | hook | Guards overlay history and re-arms after consumed nested-level back |
| use-back-dismiss.test.ts | test | Tests back dismissal and replaced-sentinel cleanup |
| use-viewport-height.ts | hook | Publishes keyboard-aware viewport size |
| use-viewport-height.test.ts | test | Unit tests for viewport height mirroring |
| v3/ | subdir | All mobile screens as screen, view and model |
| ui/ | subdir | Shared mobile kit and formatters |
| screens/ | subdir | Pure view models reused by the v3 screens |
