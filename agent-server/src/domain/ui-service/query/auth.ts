// input:  authentication snapshot reader
// output: auth.status query DTO
// pos:    Authentication status UI query adapter
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import {
  getAuthStatus,
  type AuthStatusSnapshot,
} from '@domain/auth/index.js';
import type { AuthStatusParams } from '../types.js';

type AuthStatusReader = () => Promise<AuthStatusSnapshot>;

export async function handleAuthStatus(
  _params: AuthStatusParams,
  readStatus: AuthStatusReader = getAuthStatus,
): Promise<AuthStatusSnapshot> {
  return readStatus();
}
