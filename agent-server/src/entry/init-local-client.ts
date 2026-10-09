import { beginLocalClientInstall, completeLocalClientInstall, type LocalClientPaths } from '@domain/remote/local-client-install.js';

export interface LocalClientAnswer { enabled: boolean }
export function parseLocalClientAnswer(value: unknown): LocalClientAnswer | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('--answers localClient must be an object with enabled: true or false');
  }
  const { enabled } = value as { enabled?: unknown };
  if (typeof enabled !== 'boolean') throw new Error('--answers localClient.enabled must be true or false');
  return { enabled };
}

/** Intent must survive before .env/config makes native retries take the ui-enable/daemon route. */
export async function withInitLocalClient(
  paths: LocalClientPaths,
  answers: { machineName: string; localClient?: LocalClientAnswer },
  writeConfigs: () => void,
  emit: (event: Record<string, unknown>) => void,
): Promise<void> {
  if (!answers.localClient?.enabled) return writeConfigs();
  try {
    await beginLocalClientInstall(paths, answers.machineName);
    writeConfigs();
    await completeLocalClientInstall(paths, answers.machineName);
    emit({ step: 'local-client', state: 'ok', device: answers.machineName });
  } catch (error) {
    emit({ step: 'local-client', state: 'error', reason: (error as Error).message });
    throw error;
  }
}
