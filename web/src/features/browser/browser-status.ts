export function browserStartupPending(input: {
  running: boolean;
  backgroundRunning: boolean;
  device: string | null;
  turnProgressStarted: boolean;
}): boolean {
  return input.running && !input.backgroundRunning && input.device !== null && !input.turnProgressStarted;
}

export function browserStartupHint(device: string, template: string): string {
  return template.replace('{device}', device);
}
