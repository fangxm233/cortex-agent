Please update me when files in this folder change.

DEV-only demo surfaces. Not product code: `router.tsx` registers them only under
`import.meta.env.DEV`, behind `lazy()` imports inside the dead branch, so Rollup drops
both pages (and their chunks) from a production build. `dev-only-from-router` forbids any
other module importing `dev/`; `dev/` itself may import anything — showing the tree off is
the point.

| filename | role | function |
|---|---|---|
| kit/KitPage.tsx | entry | `/kit` — every `design/` primitive rendered in every state, for eyeballing token changes |
| kit/DegradedDemos.tsx | core | The degraded/exception specimens (`DegradedState`, severities, tones) that `KitPage` embeds |
| base-demo/BaseDemoPage.tsx | entry | `/base` — the prototype specimen kept renderable, so 1:1 chrome can be diffed against it |
