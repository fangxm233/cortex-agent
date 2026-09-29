// Re-export from store/task-repo.ts (S3 Pattern B migration, 2026-04-23)
// All consumers keep existing import paths: `from './task-store.js'`

export { taskStore, TaskRepo } from '@store/task-repo.js';
