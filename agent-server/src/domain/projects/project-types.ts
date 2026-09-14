export interface Project {
  /** Directory name under PROJECTS_DIR, e.g. "cortex-self". Also the canonical identifier. */
  id: string;
  /** Human-readable name. Same as `id` by default; may be refined later. */
  name: string;
  /** 'general' = synthetic umbrella project (always present, never persisted on disk).
   *  'user' = real project directory under PROJECTS_DIR. */
  kind: 'general' | 'user';
  /** Absolute path to the project's directory under PROJECTS_DIR. */
  contextDir: string;
}
