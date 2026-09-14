import * as dotenv from 'dotenv';

const FILE_ONLY_ENV_KEYS = new Set([
  'CLAUDE_CODE_OAUTH_TOKEN_EXPIRES_AT',
]);

export function loadRuntimeDotenv(
  filePath: string,
  target: NodeJS.ProcessEnv = process.env,
): void {
  const fileEnv: NodeJS.ProcessEnv = {};
  dotenv.config({ path: filePath, processEnv: fileEnv });
  for (const key of FILE_ONLY_ENV_KEYS) delete fileEnv[key];
  dotenv.populate(target, fileEnv);
}
