// input:  source channel identifiers and MCP CallToolResult content items
// output: platform-server loading decisions and lossless PI text-content mapping
// pos:    pure policy/codec layer consumed by the PI MCP bridge and behavior tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

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
