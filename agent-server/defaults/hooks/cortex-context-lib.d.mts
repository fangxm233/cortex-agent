// Types for cortex-context-lib.mjs, which the server imports from the shipped defaults/hooks/.

export declare const SESSION_ID_RE: RegExp;
export declare const CACHE_TTL_MS: number;
export declare const MAX_CONTEXT_CHARS: number;

export declare function agentsMdCacheDir(home: string): string;
export declare function rulesCacheDir(home: string): string;
export declare function isValidSessionId(sessionId: unknown): sessionId is string;
export declare function agentsMdCacheKey(deviceId: string, filePath: string): string;
export declare function pruneCacheDir(dir: string, ttlMs?: number): void;
export declare function readJsonFile(file: string): unknown;
export declare function writeJsonFileAtomic(file: string, value: unknown): void;

export interface CacheOperationResult<T> {
  value: T;
  changed: boolean;
}

export declare function withAgentsMdCache<T>(
  cacheDir: string,
  sessionId: string | undefined,
  operation: (cache: Map<string, number>) => CacheOperationResult<T>,
  memoryCache?: Map<string, number>,
): T;

export interface BudgetSelection<E> {
  included: E[];
  blocks: string[];
  truncated: E[];
}

export declare function selectWithinBudget<E>(
  entries: E[],
  formatBlock: (entry: E) => string,
  maxChars?: number,
): BudgetSelection<E>;

export declare function overflowNotice(labels: string[]): string;

export interface RuleFile {
  file: string;
  /** Absolute path of the file the rule was read from. */
  path: string;
  paths: string[];
  body: string;
}

export declare function parseRuleFrontmatter(content: string): { paths: string[]; body: string };
export declare function loadRules(rulesDir: string): RuleFile[];
export declare const BUILTIN_RULES_DIR: string;
export declare function builtinRulesDir(): string | null;
export declare function loadLayeredRules(userDir: string, builtinDir?: string | null): RuleFile[];
