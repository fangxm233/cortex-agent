// input:  direct sessions, listed projects, and an optional explicit selection
// output: derived and effective current-project identifiers
// pos:    Shared project-selection resolver for desktop and mobile
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { ProjectConduitInfo, SessionInfo } from '@cortex-agent/ui-contract';

/** Most-recently-used session project, then first listed project, then no project. */
export function deriveActiveProjectId(
  sessions: SessionInfo[],
  projects: ProjectConduitInfo[],
): string | null {
  if (sessions.length > 0) {
    const latest = [...sessions].sort(
      (a, b) => Date.parse(b.lastUsedAt || b.createdAt) - Date.parse(a.lastUsedAt || a.createdAt),
    )[0];
    if (latest?.projectId) return latest.projectId;
  }
  return projects[0]?.id ?? null;
}

/** An explicit user selection stays sticky ahead of the shared derived default. */
export function resolveCurrentProjectId(
  override: string | null,
  sessions: SessionInfo[],
  projects: ProjectConduitInfo[],
): string | null {
  return override ?? deriveActiveProjectId(sessions, projects);
}
