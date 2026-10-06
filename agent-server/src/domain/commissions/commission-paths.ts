import * as path from 'node:path';
import { projectStore } from '@domain/projects/project-store.js';

/** Draft dirs (`commissions/_draft-*`) hold contracts still under drill; they are never
 *  registered — finalize renames them to the approved slug (DR-0037). */
export const DRAFT_DIR_PREFIX = '_draft-';

/** The server-side decision projection inside a commission directory (DR-0037). */
export const DECISIONS_FILE = 'decisions.jsonl';

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

/** Where a commission's directory sits inside its project's context directory. The one statement
 *  of that layout: the absolute helpers below join it onto the context dir, and readers that must
 *  confine a path to the project root (`commissions.decisions`) resolve it relative to their root. */
export function commissionRelPath(slug: string, file?: string): string {
  return file ? path.join('commissions', slug, file) : path.join('commissions', slug);
}

function contextDirOf(projectId: string): string | null {
  return projectStore.get(projectId)?.contextDir ?? null;
}

export function commissionsRoot(projectId: string): string | null {
  const contextDir = contextDirOf(projectId);
  return contextDir ? path.join(contextDir, 'commissions') : null;
}

export function commissionDir(projectId: string, slug: string): string | null {
  const contextDir = contextDirOf(projectId);
  return contextDir ? path.join(contextDir, commissionRelPath(slug)) : null;
}

export function commissionDecisionsFile(projectId: string, slug: string): string | null {
  const contextDir = contextDirOf(projectId);
  return contextDir ? path.join(contextDir, commissionRelPath(slug, DECISIONS_FILE)) : null;
}
