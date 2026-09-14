export interface TuiConduitState {
  sessionId: string | null;
  projectId: string;
  backend: string;
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

export function hasConduitState(conduitId: string): boolean {
  return tuiConduitStates.has(conduitId);
}
