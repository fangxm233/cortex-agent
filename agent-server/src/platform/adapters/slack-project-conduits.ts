// input:  ./project-conduits.js
// output: SlackProjectConduitsStore (backward-compat alias of ProjectConduitsStore)
// pos:    Compat shim — the store is now platform-agnostic (project-conduits.ts).
//         Kept so existing Slack imports resolve unchanged.

export { ProjectConduitsStore as SlackProjectConduitsStore } from './project-conduits.js';
