// input:  session environment and MCP result content
// output: MCP loading predicates and PI text-content mapping
// pos:    Pure policy and codec layer for the PI MCP bridge
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

/** Load platform-specific tools only for sessions originating from that platform. */
export function shouldLoadSlack(channel: string | undefined): boolean {
  return !!channel && channel.startsWith('slack:');
}

export function shouldLoadFeishu(channel: string | undefined): boolean {
  return !!channel && channel.startsWith('feishu:');
}

export function shouldLoadWeb(channel: string | undefined): boolean {
  return !!channel && channel.startsWith('web:');
}

export function shouldLoadThreadControl(threadId: string | undefined): boolean {
  return !!threadId;
}

type PiTextContent = { type: 'text'; text: string };

/** Map an MCP content item into PI text without silently dropping unsupported payloads. */
export function mapMcpContent(item: {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: { uri?: string; text?: string; blob?: string; mimeType?: string };
  [key: string]: unknown;
}): PiTextContent {
  if (item.type === 'text' && typeof item.text === 'string') {
    return { type: 'text', text: item.text };
  }
  if (item.type === 'image') {
    const len = typeof item.data === 'string' ? item.data.length : 0;
    return { type: 'text', text: `[Image: mimeType=${item.mimeType ?? 'unknown'}, base64(${len} chars)]` };
  }
  if (item.type === 'resource' && item.resource) {
    const resource = item.resource;
    if (typeof resource.text === 'string') return { type: 'text', text: resource.text };
    if (typeof resource.blob === 'string') {
      return {
        type: 'text',
        text: `[Binary resource: uri=${resource.uri ?? 'unknown'}, mimeType=${resource.mimeType ?? 'unknown'}]`,
      };
    }
  }
  return { type: 'text', text: JSON.stringify(item) };
}
