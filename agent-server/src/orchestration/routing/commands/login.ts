// input:  authentication snapshot reader and localized formatter
// output: !login / !login status command handler
// pos:    Chat authentication status adapter
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { t } from '@core/i18n.js';
import {
  formatAuthStatusSummary,
  getAuthStatus,
  type AuthStatusSnapshot,
} from '@domain/auth/index.js';
import type { CommandResult } from './command-context.js';

type AuthStatusReader = () => Promise<AuthStatusSnapshot>;

function requestsStatus(message: string): boolean {
  const args = message.trim().split(/\s+/).slice(1);
  return args.length === 0 || (args.length === 1 && args[0] === 'status');
}

export function createLoginHandler(readStatus: AuthStatusReader = getAuthStatus) {
  return async function handleLoginCmd(message: string): Promise<CommandResult> {
    if (!requestsStatus(message)) return { text: t('cmd.auth.usage') };
    return { text: formatAuthStatusSummary(await readStatus()) };
  };
}
