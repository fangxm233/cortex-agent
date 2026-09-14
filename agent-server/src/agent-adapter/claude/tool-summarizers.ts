export const TOOL_INPUT_SUMMARIZERS: Record<string, (inp: any) => string> = {
  Bash:  (inp) => inp.command || '',
  Read:  (inp) => inp.file_path || JSON.stringify(inp),
  Write: (inp) => inp.file_path || JSON.stringify(inp),
  Edit:  (inp) => inp.file_path || JSON.stringify(inp),
  Grep:  (inp) => inp.pattern || JSON.stringify(inp),
  Glob:  (inp) => inp.pattern || JSON.stringify(inp),
  Task:  (inp) => inp.description || JSON.stringify(inp),
  mcp__cortex__slack_send_file: (inp) => {
    const filePath = inp.file_path || '';
    const comment = inp.comment || '';
    return comment ? `${comment} [file: ${filePath}]` : `[file: ${filePath}]`;
  },
};

export function summarizeToolInput(name: string, inp: any): string {
  const fn = TOOL_INPUT_SUMMARIZERS[name];
  if (fn) return fn(inp);
  return JSON.stringify(inp);
}
