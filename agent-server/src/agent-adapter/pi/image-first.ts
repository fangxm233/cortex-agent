import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function reorderToolResult(value: unknown): void {
  const block = record(value);
  if (block?.type !== 'tool_result' || !Array.isArray(block.content)) return;
  const images: unknown[] = [];
  const other: unknown[] = [];
  for (const part of block.content) {
    (record(part)?.type === 'image' ? images : other).push(part);
  }
  if (images.length) block.content = [...images, ...other];
}

/** Normalize the serialized request, including placeholder text added by Pi's SDK. */
export function installImageFirst(pi: ExtensionAPI): void {
  pi.on('before_provider_request', (event, ctx) => {
    if (ctx.model?.api !== 'anthropic-messages') return;
    const messages = record(event.payload)?.messages;
    if (!Array.isArray(messages)) return;
    for (const message of messages) {
      const content = record(message)?.content;
      if (Array.isArray(content)) content.forEach(reorderToolResult);
    }
    return event.payload;
  });
}
