import * as fs from 'node:fs';
import * as path from 'node:path';
import { STORE_DIR } from '@core/paths.js';
import { createLogger } from '@core/log.js';

const log = createLogger('github-release');

const GITHUB_API_BASE = 'https://api.github.com';
const REPO_OWNER = 'fangxm233';
const REPO_NAME = 'cortex-agent';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CACHE_FILE = path.join(STORE_DIR, 'release-cache.json');

export interface ReleaseInfo {
  tagName: string;    // e.g., "server-v2026.6.11"
  version: string;    // e.g., "2026.6.11"
  name: string;       // Release title
  body: string;       // Markdown release notes
  htmlUrl: string;    // GitHub release page URL
  publishedAt: string; // ISO timestamp
}

interface CacheEntry {
  info: ReleaseInfo;
  fetchedAt: number;
}

interface ReleaseCache {
  releases: Record<string, CacheEntry>;
}

/**
 * Load cache from disk, or return empty structure if missing/invalid.
 */
function loadCache(): ReleaseCache {
  if (!fs.existsSync(CACHE_FILE)) {
    return { releases: {} };
  }
  try {
    const data = fs.readFileSync(CACHE_FILE, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    log.warn(`Failed to load release cache: ${(e as Error).message}`);
    return { releases: {} };
  }
}

/**
 * Save cache to disk.
 */
function saveCache(cache: ReleaseCache): void {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (e) {
    log.warn(`Failed to save release cache: ${(e as Error).message}`);
  }
}

/**
 * Build GitHub Release API URL for a given version.
 * GitHub tag format: server-v{version}
 */
function buildGitHubApiUrl(version: string): string {
  const tagName = `server-v${version}`;
  return `${GITHUB_API_BASE}/repos/${REPO_OWNER}/${REPO_NAME}/releases/tags/${tagName}`;
}

/**
 * Build GitHub Release web URL for a given version.
 */
export function buildGitHubReleaseUrl(version: string): string {
  const tagName = `server-v${version}`;
  return `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/tag/${tagName}`;
}

/**
 * Fetch release notes from GitHub API for a given version.
 * Returns cached result if available and not expired.
 * Returns null if fetch fails or release doesn't exist.
 */
export async function fetchReleaseNote(version: string): Promise<ReleaseInfo | null> {
  const cache = loadCache();
  const cached = cache.releases[version];

  // Check if cache is valid (not expired)
  if (cached) {
    const age = Date.now() - cached.fetchedAt;
    if (age < CACHE_TTL_MS) {
      log.debug(`Using cached release note for ${version}`);
      return cached.info;
    }
  }

  // Fetch from GitHub API
  const url = buildGitHubApiUrl(version);
  try {
    const response = await fetch(url);

    if (!response.ok) {
      if (response.status === 404) {
        log.warn(`Release not found for version ${version}`);
      } else {
        log.warn(`GitHub API error: ${response.status} ${response.statusText}`);
      }
      return null;
    }

    const data = (await response.json()) as any;
    const releaseInfo: ReleaseInfo = {
      tagName: data.tag_name,
      version,
      name: data.name || `Release ${version}`,
      body: data.body || '',
      htmlUrl: data.html_url,
      publishedAt: data.published_at,
    };

    // Update cache
    cache.releases[version] = {
      info: releaseInfo,
      fetchedAt: Date.now(),
    };
    saveCache(cache);

    return releaseInfo;
  } catch (error) {
    log.error(`Failed to fetch release note for ${version}: ${(error as Error).message}`);
    return null;
  }
}
