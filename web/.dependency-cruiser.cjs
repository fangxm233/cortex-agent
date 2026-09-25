/** @type {import('dependency-cruiser').IConfiguration} */
//
// Import-direction rules for the web SPA (see web/AGENTS.md for the map).
//
// The layering, bottom to top:
//   lib/                  → ()                    L0  platform shell + pure utils
//   design/ theme/ i18n/  → lib                   L1  foundation kits (no app knowledge)
//   features/<name>/      → lib, foundation       L2  one feature = one dir
//   shell/                → lib, foundation, features   L3  desktop chrome + providers
//   mobile/               → lib, foundation, features   L3  the other chrome
//   dev/                  → *                      L3  DEV-only demo routes, shipped to nobody
//   router.tsx & co       → *                     L4  the only place both chromes meet
//
// The two chromes are siblings, not a stack: `features/` is the shared body, `shell/`
// and `mobile/` are two heads on it, and neither may reach into the other. Anything a
// feature wants from `mobile/` is really a shared primitive and belongs in design/ or
// features/.
//
// Severity is `error` so CI breaks on new violations — `build` runs `depcruise` before
// `vite build`. Type-only imports are excluded (dependencyTypesNot: ['type-only']):
// type leaks across layers are tolerated, runtime coupling is what we want to catch.
// Test files are exempt from every rule (from.pathNot) — a test may import anything it
// needs to drive the unit under test.
//
// Violations that exist TODAY are frozen into .dependency-cruiser-known-violations.json
// and skipped by `--ignore-known`. That baseline may only ever shrink: regenerating it
// to absorb a new violation defeats the whole file. See web/AGENTS.md.
//
const COMMON_OPTS = { dependencyTypesNot: ['type-only'] };
const NOT_A_TEST = { pathNot: '\\.test\\.tsx?$' };

module.exports = {
  forbidden: [
    {
      name: 'lib-is-bottom',
      severity: 'error',
      comment:
        'lib/ is the bottom of the stack: platform shell (tauri/browser), transport, pure '
        + 'helpers. It must know nothing about the app above it — not a feature, not a chrome, '
        + 'not even the vocab. The pull is always the same shape: a lib module wants one '
        + 'constant or one callback that today lives in a feature. Both go the other way — the '
        + 'constant moves down into lib (use-mobile-layout owns MOBILE_MAX_WIDTH), the callback '
        + 'becomes a subscription the feature registers (manual-update-check-result.ts).',
      from: { path: '^src/lib/', ...NOT_A_TEST },
      to: { path: '^src/(features|mobile|shell|i18n|design|theme)/', ...COMMON_OPTS },
    },
    {
      name: 'foundation-not-to-app',
      severity: 'error',
      comment:
        'design/ theme/ i18n/ are context-free kits: primitives, runtime appearance, vocab. '
        + 'They are imported BY the app and must never import it back, or every feature ends '
        + 'up in the same module graph as the Button.',
      from: { path: '^src/(design|theme|i18n)/', ...NOT_A_TEST },
      to: { path: '^src/(features|mobile|shell)/', ...COMMON_OPTS },
    },
    {
      name: 'features-not-to-mobile',
      severity: 'error',
      comment:
        'features/ is shared by both chromes, so it may not depend on one of them. A feature '
        + 'reaching into @/mobile for a primitive — a sheet, a token table, a dismiss hook — '
        + 'is asking for something that should live in design/ instead.',
      from: { path: '^src/features/', ...NOT_A_TEST },
      to: { path: '^src/mobile/', ...COMMON_OPTS },
    },
    {
      name: 'shell-not-to-mobile',
      severity: 'error',
      comment: 'the desktop chrome and the mobile chrome are siblings; neither imports the other',
      from: { path: '^src/shell/', ...NOT_A_TEST },
      to: { path: '^src/mobile/', ...COMMON_OPTS },
    },
    {
      name: 'mobile-only-from-router',
      severity: 'error',
      comment:
        'mobile/ is entered through the router and nowhere else. Only router.tsx, '
        + 'responsive-route.tsx and RootRouter.tsx — the three modules whose job is to pick a '
        + 'chrome — may import it from outside src/mobile/. This keeps the mobile tree '
        + 'deletable/movable as a unit.',
      from: {
        path: '^src/(?!mobile/|router\\.tsx|responsive-route\\.tsx|RootRouter\\.tsx)',
        ...NOT_A_TEST,
      },
      to: { path: '^src/mobile/', ...COMMON_OPTS },
    },
    {
      name: 'dev-only-from-router',
      severity: 'error',
      comment:
        'dev/ holds DEV-only demo surfaces (/kit, /base). Only router.tsx may reach them, and '
        + 'only from inside an `import.meta.env.DEV` branch, so the production bundle drops '
        + 'them. Anything a demo page shows that the product also needs belongs in design/ or '
        + 'features/ — importing dev/ from either would put a demo in the shipped graph. The '
        + 'reverse direction is free: dev/ may import anything it wants to demonstrate.',
      from: { path: '^src/(?!dev/|router\\.tsx)', ...NOT_A_TEST },
      to: { path: '^src/dev/', ...COMMON_OPTS },
    },
    {
      name: 'components-not-direct-trpc',
      severity: 'error',
      comment:
        'a component renders; it does not open a transport. Data access goes through a '
        + 'use*Resource / use*Controller hook or a *-vm module, so the view stays testable '
        + 'without a tRPC client and the query keys live in one place. New violations are '
        + 'forbidden; the ~55 that exist today are in the known-violations baseline and are '
        + 'to be worked off — the baseline may only shrink.',
      from: { path: '^src/(features|mobile|shell)/.*\\.tsx$', ...NOT_A_TEST },
      to: { path: '^src/lib/trpc', ...COMMON_OPTS },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'module-level import cycles. Directory-level cycles between features are a separate '
        + 'check that dependency-cruiser cannot express — see scripts/check-feature-cycles.mjs '
        + 'and its allow-list.',
      from: { ...NOT_A_TEST },
      to: { circular: true, ...COMMON_OPTS },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: 'node_modules|dist',
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
  },
};
