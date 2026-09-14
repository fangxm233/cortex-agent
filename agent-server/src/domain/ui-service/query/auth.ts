import {
  getAuthStatus,
  getFlowState,
  type AuthStatusSnapshot,
  type LoginFlowState,
} from '@domain/auth/index.js';
import type { AuthFlowStateParams, AuthStatusParams } from '../types.js';

type AuthStatusReader = () => Promise<AuthStatusSnapshot>;

export async function handleAuthStatus(
  _params: AuthStatusParams,
  readStatus: AuthStatusReader = getAuthStatus,
): Promise<AuthStatusSnapshot> {
  return readStatus();
}

export async function handleAuthFlowState(
  params: AuthFlowStateParams,
  readState: (flowId: string) => LoginFlowState | null = getFlowState,
): Promise<LoginFlowState | null> {
  const state = readState(params.flowId);
  return state?.channel === null && state.sessionId === null ? state : null;
}
