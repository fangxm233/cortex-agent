// input:  node:path, projectStore
// output: slugifyCommissionName + commission dir/file resolvers
// pos:    Slug rules and context-dir path resolution for commissions
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import * as path from 'node:path';
import { projectStore } from '@domain/projects/project-store.js';

/** Draft dirs (`commissions/_draft-*`) hold contracts still under drill; they are never
 *  registered — finalize renames them to the approved slug (DR-0037). */
export const DRAFT_DIR_PREFIX = '_draft-';

/** Normalize a human commission name to a directory slug. Returns null when nothing
 *  slug-safe remains (e.g. fully non-ASCII input) — callers must surface that as an error. */
export function slugifyCommissionName(name: string): string | null {
  const slug = name.trim().toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
    .replace(/-$/, '');
  return slug ? slug : null;
}

export function contextDirOf(projectId: string): string | null {
  return projectStore.get(projectId)?.contextDir ?? null;
}

export function commissionsRoot(projectId: string): string | null {
  const contextDir = contextDirOf(projectId);
  return contextDir ? path.join(contextDir, 'commissions') : null;
}

export function commissionDir(projectId: string, slug: string): string | null {
  const root = commissionsRoot(projectId);
  return root ? path.join(root, slug) : null;
}

export function commissionDecisionsFile(projectId: string, slug: string): string | null {
  const dir = commissionDir(projectId, slug);
  return dir ? path.join(dir, 'decisions.jsonl') : null;
}
