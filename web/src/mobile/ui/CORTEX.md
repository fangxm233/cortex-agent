Please update me when files in this folder change

Shared presentational kit for every mobile screen, so the whole mobile surface reads as one design system.
Provides the palette, screen frame, headers, cards, pills, segmented control, bottom sheet and composer.

| filename | role | function |
|---|---|---|
| kit.tsx | facade | Supplies non-composer primitives and preserves shared public exports |
| composer.tsx | view | Renders inline/fullscreen composer presentation and text metrics |
| mobile-theme.ts | tokens | Exposes the shared mobile palette and monospace stack |
| kit.test.ts | test | Tests sheet viewport, dismissal and Unicode-safe counts |
| format.ts | util | Formats relative time, money and copy |
