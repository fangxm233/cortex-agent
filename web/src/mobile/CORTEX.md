Please update me when files in this folder change

The mobile surface: its own router, four-tab shell and route-transition chrome, separate from desktop.
This level holds the shell frame, tab/route model and mobile-only cross-screen logic.
An element-free declarative manifest now owns route paths, tab attribution and semantic parents; screen elements remain explicit in the route table.
Android back handling consumes the manifest and canonical typed native bridge, including race-safe idempotent teardown.

| filename | role | function |
|---|---|---|
| mobile-router.tsx | entry | Builds the mobile-only router through the shared shell-router factory |
| mobile-route-manifest.ts | core | Owns element-free paths, tab attribution, matching and semantic parents |
| mobile-route-manifest.test.ts | test | Tests registry integrity, dynamic matching and parameterized parents |
| mobile-routes.tsx | entry | Explicitly maps manifest route ids to React screen elements |
| mobile-routes.test.tsx | test | Verifies manifest registration plus supported settings routes |
| MobileShell.tsx | core | Frames project scope, outlet, native back, tabs and one prioritized update provider |
| MobileAnimatedOutlet.tsx | core | Animates routes and retains the source tab frame |
| MobileAnimatedOutlet.test.tsx | test | Tests transitions and retained tab frames |
| BottomTabBar.tsx | view | Four-tab bottom bar with icons and badges |
| mobile-navigation.ts | core | Applies manifest-derived semantic back and delegates native payloads to the bridge |
| mobile-navigation.test.ts | test | Tests parameterized parents, fallback, Router history and tab switching |
| mobile-tabs.ts | core | Derives tab paths and path attribution from the route manifest |
| mobile-tabs.test.ts | test | Unit tests for derived path-to-tab mapping |
| use-back-dismiss.ts | hook | Guards overlay history and re-arms after consumed nested-level back |
| use-back-dismiss.test.ts | test | Tests back dismissal and replaced-sentinel cleanup |
| use-viewport-height.ts | hook | Publishes keyboard-aware viewport size |
| use-viewport-height.test.ts | test | Unit tests for viewport height mirroring |
| v3/ | subdir | All mobile screens as screen, view and model |
| ui/ | subdir | Shared mobile kit and formatters |
| screens/ | subdir | Pure view models reused by the v3 screens |
