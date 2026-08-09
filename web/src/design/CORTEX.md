Please update me when files in this folder change

Design-system primitives: every color, space, radius and shadow resolves to a Tailwind token, never a literal.
Interactive parts wrap Radix for accessibility; pure modules hold the tested status and queue semantics.

| filename | role | function |
|---|---|---|
| index.ts | barrel | Re-exports all primitives and their types |
| Button.tsx | core | Ref-forwarding button with variants and sizes |
| Card.tsx | core | Card surface with header and body parts |
| SectionHeader.tsx | core | Section title with count, actions and description |
| StatusPill.tsx | core | Status badge colored by resolved tone |
| MonoText.tsx | core | Text in the monospace data style |
| ID.tsx | core | Identifier with click-to-copy |
| Tabs.tsx | core | Tab set as data-driven form and styled parts |
| Tooltip.tsx | core | Hover tooltip plus its provider export |
| Modal.tsx | core | Centered accessible dialog with size and layer variants |
| Modal.test.ts | test | Tests nested dialog stacking order |
| Drawer.tsx | core | Side sheet dialog anchored left or right |
| Popover.tsx | core | Anchored popover panel with arrow |
| Select.tsx | core | Accessible profile-styled selection menu |
| Select.test.tsx | test | Tests typed value mapping and option states |
| Toast.tsx | provider | Toast context, viewport and imperative hook |
| EmptyState.tsx | core | Centered empty placeholder with optional action |
| DegradedState.tsx | core | Degraded or exception status card |
| tone.ts | util | Maps contract status strings to five tones |
| tone.test.ts | test | Unit tests for status-to-tone mapping |
| degraded.ts | util | Maps degraded severities to pill tones |
| toast-store.ts | util | Toast queue add and remove with a max cap |
| toast-store.test.ts | test | Unit tests for the toast queue |
