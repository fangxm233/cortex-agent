import type { Lang } from '@/i18n';

export const NP_PLACEHOLDER = 'nimbus';

/** Shown when the backend rejects a create without a message of its own. */
export const PROJECT_CREATE_FAILED: Record<Lang, string> = {
  en: 'Could not create project.',
  zh: '无法创建项目。',
};

/** A trimmed project name must contain content before either surface may submit it. */
export function canCreateProject(name: string): boolean {
  return name.trim().length > 0;
}

/** Preserve a real backend error message; use the (localized) `fallback` only when none is available. */
export function projectCreateErrorMessage(error: unknown, fallback: string): string {
  const message =
    error && typeof error === 'object' && 'message' in error
      ? (error as { message?: unknown }).message
      : undefined;
  if (typeof message === 'string' && message.trim().length > 0) return message;
  return fallback;
}
