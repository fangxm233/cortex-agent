export interface TuiConduitState {
  sessionId: string | null;
  projectId: string;
}

export const tuiConduitStates = new Map<string, TuiConduitState>();

export function getConduitState(conduitId: string): TuiConduitState | undefined {
  return tuiConduitStates.get(conduitId);
}

export function setConduitState(conduitId: string, state: TuiConduitState): void {
  tuiConduitStates.set(conduitId, state);
}

export function deleteConduitState(conduitId: string): boolean {
  return tuiConduitStates.delete(conduitId);
}
