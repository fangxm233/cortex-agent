import * as fs from 'node:fs';
import * as path from 'node:path';
import type { UiServiceDeps, ProjectConduitInfo } from '../types.js';

function projectHasMission(contextDir: string): boolean {
  try {
    return fs.existsSync(path.join(contextDir, 'mission.md'));
  } catch {
    return false;
  }
}

export async function handleProjectsList(deps: UiServiceDeps): Promise<ProjectConduitInfo[]> {
  const projects = deps.projectStore.list();
  let conduits: Record<string, string> = {};
  try {
    conduits = await deps.adapter.getProjectConduits();
  } catch {
    // conduit lookup failure is non-fatal; projects still listed with empty conduits
  }

  return projects.map((p) => ({
    id: p.id,
    kind: p.kind === 'general' ? 'general' as const : 'research' as const,
    contextDir: p.contextDir,
    hasMission: projectHasMission(p.contextDir),
    conduits,
  }));
}
