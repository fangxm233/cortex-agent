// input:  re-exports from core/task-parser.ts (read-only parsing utilities)
// output: same public API surface as before, but implementation lives in core/
// pos:    store/task-repo.ts imports from @core/task-parser.js instead of @domain/tasks/parser.js
//         This satisfies the dep-cruiser store→domain rule (S4 refactor).

export * from '@core/task-parser.js';
