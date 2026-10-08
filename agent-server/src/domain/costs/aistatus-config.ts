import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { AISTATUS_DIR } from '@core/paths.js';

/**
 * The opt-in for the public aistatus.cc usage leaderboard, as stored in `~/.aistatus/config.yaml`.
 * That file belongs to the aistatus SDK: the gateway reads it to decide whether to upload token
 * counts, and only uploads when `uploadEnabled`, `name` and `email` are all set.
 */
export interface UsageSharingSettings {
  enabled: boolean;
  name: string;
  org: string;
  email: string;
}

/** A requested change. Identity fields only apply when enabling; disabling keeps the stored ones. */
export interface UsageSharingUpdate {
  enabled: boolean;
  name?: string;
  org?: string;
  email?: string;
}

export type UsageSharingIssue = 'name-required' | 'email-invalid';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function configPath(dir: string): string {
  return path.join(dir, 'config.yaml');
}

/** The parsed file as a plain object; missing, unreadable or non-mapping content reads as empty. */
function readRaw(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try {
    const parsed = yaml.parse(readFileSync(file, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function readUsageSharing(dir: string = AISTATUS_DIR): UsageSharingSettings {
  const raw = readRaw(configPath(dir));
  return {
    enabled: raw.uploadEnabled === true,
    name: text(raw.name),
    org: text(raw.org),
    email: text(raw.email),
  };
}

/** Rules a change must meet before it is written; the SDK will not upload without name and email. */
export function usageSharingIssues(update: UsageSharingUpdate): UsageSharingIssue[] {
  if (!update.enabled) return [];
  const issues: UsageSharingIssue[] = [];
  if (!update.name?.trim()) issues.push('name-required');
  if (!EMAIL_RE.test(update.email?.trim() ?? '')) issues.push('email-invalid');
  return issues;
}

/**
 * Write the choice in place, keeping keys this module does not own. The gateway picks the file up
 * on its own, so nothing is restarted here.
 */
export function writeUsageSharing(update: UsageSharingUpdate, dir: string = AISTATUS_DIR): void {
  const file = configPath(dir);
  mkdirSync(dir, { recursive: true });
  const existing = readRaw(file);
  const identity = update.enabled
    ? { name: update.name || '', org: update.org || '', email: update.email || '' }
    : { name: existing.name ?? '', org: existing.org ?? '', email: existing.email ?? '' };
  writeFileSync(file, yaml.stringify({ ...existing, ...identity, uploadEnabled: update.enabled }));
}
