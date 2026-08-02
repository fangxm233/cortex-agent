// input:  dotenv files and target process environments
// output: dotenv loading with file-only key exclusion
// pos:    Runtime environment loading policy
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

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
