Please update me when files in this folder change

Shared presentational kit for every mobile screen, so the whole mobile surface reads as one design system.
Provides the palette, screen frame, headers, cards, distinct mobile pill visuals, sheets and composer.
Status pills reuse the canonical design Tone/status mapping while keeping their mobile rendering.

| filename | role | function |
|---|---|---|
| kit.tsx | facade | Supplies primitives, canonical-tone mobile pills and back-aware nested sheets |
| composer.tsx | view | Renders inline/fullscreen composer presentation and text metrics |
| mobile-theme.ts | tokens | Exposes the shared mobile palette and monospace stack |
| kit.test.ts | test | Tests sheet viewport, dismissal and Unicode-safe counts |
| format.ts | util | Formats relative time, money and copy |
