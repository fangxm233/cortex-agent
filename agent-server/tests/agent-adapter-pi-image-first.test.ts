import { describe, expect, test } from 'vitest';
import type { Context, Model, ToolResultMessage } from '@earendil-works/pi-ai';
import type {
  BeforeProviderRequestEvent, ExtensionAPI, ExtensionContext, InlineExtension,
} from '@earendil-works/pi-coding-agent';
import { createCortexExtensions } from '../src/agent-adapter/pi/extensions.js';
import { childExtensions } from '../src/agent-adapter/pi/tool-shims.js';
import type { PiSessionRequest } from '../src/agent-adapter/pi/session-options.js';

type Handler = (event: BeforeProviderRequestEvent, ctx: ExtensionContext) => unknown;
const env = { CORTEX_PI_ALLOWED_TOOLS: 'Read', CORTEX_PI_SUBAGENT: '1' };

function extensions(disableHooks: boolean): InlineExtension[] {
  return createCortexExtensions({ env, disableHooks, pluginMcpServers: [] } as unknown as PiSessionRequest);
}

async function transform(factories: InlineExtension[], payload: unknown, api = 'anthropic-messages') {
  const handlers: Handler[] = [];
  const pi = {
    on: (name: string, handler: Handler) => { if (name === 'before_provider_request') handlers.push(handler); },
    registerTool: () => {},
  } as unknown as ExtensionAPI;
  for (const extension of factories) await extension.factory(pi);
  const ctx = { model: { api, provider: 'custom-gateway' } } as ExtensionContext;
  for (const handler of handlers) payload = await handler({ type: 'before_provider_request', payload }, ctx) ?? payload;
  return payload;
}

const text = (value: string) => ({ type: 'text', text: value });
const image = (data: string) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } });
const result = (content: unknown) => ({ type: 'tool_result', tool_use_id: 'read-1', is_error: false, content });
const payload = (blocks: unknown[]) => ({ model: 'fixture', messages: [{ role: 'user', content: blocks }] });

const sessions = [
  ['default', () => extensions(false)],
  ['hooks disabled', () => extensions(true)],
  ['nested child', () => childExtensions(env)],
] as const;

describe.each(sessions)('%s', (_name, factories) => {
  test('stably partitions only tool-result content, preserving every block and metadata', async () => {
    const blocks = [text('before'), image('one'), { type: 'document', source: { data: 'doc' } },
      text('after'), image('two')];
    const tool = { ...result(blocks), cache_control: { type: 'ephemeral' } };
    const outer = [text('outside'), tool, image('outside')];
    const request = { ...payload(outer), metadata: { user_id: 'fixture' } };
    request.messages.push({ role: 'assistant', content: [text('untouched')] });
    const snapshot = structuredClone(request);
    const output = await transform(factories(), request) as typeof request;
    const expected = structuredClone(snapshot);
    (expected.messages[0].content[1] as typeof tool).content = [blocks[1], blocks[4], blocks[0], blocks[2], blocks[3]];
    expect(output).toEqual(expected);
    expect(tool.content).toEqual([blocks[1], blocks[4], blocks[0], blocks[2], blocks[3]]);
    for (const block of blocks) expect(tool.content.some(part => part === block)).toBe(true);
    expect(await transform(factories(), output)).toEqual(expected);
  });

  test('moves the SDK pure-image placeholder after all images in multiple results', async () => {
    const one = image('one');
    const two = image('two');
    const placeholder = text('(see attached image)');
    const first = result([placeholder, one, two]);
    const second = result([text('mixed'), two]);
    const request = payload([first, second]);
    await transform(factories(), request);
    expect(first.content).toEqual([one, two, placeholder]);
    expect(second.content).toEqual([two, text('mixed')]);
  });

  test('leaves text-only, string, empty and already image-first results unchanged', async () => {
    const request = payload([result([text('a'), text('b')]), result('plain'), result([]),
      result([image('one'), text('last')])]);
    const before = structuredClone(request);
    expect(await transform(factories(), request)).toEqual(before);
  });

  test.each(['openai-completions', 'openai-responses', 'google-generative-ai', 'bedrock-converse-stream'])(
    'leaves %s untouched even with Anthropic-shaped data', async api => {
      const request = payload([result([text('first'), image('one')])]);
      const before = structuredClone(request);
      expect(await transform(factories(), request, api)).toBe(request);
      expect(request).toEqual(before);
    },
  );
});

const model: Model<'anthropic-messages'> = {
  id: 'offline-fixture', name: 'Offline fixture', api: 'anthropic-messages', provider: 'custom-gateway',
  baseUrl: 'https://offline.invalid', reasoning: false, input: ['text', 'image'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 128,
};

function sdkContext(content: ToolResultMessage['content']): Context {
  return { messages: [
    { role: 'user', content: 'read the image', timestamp: 1 },
    { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: 2,
      stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'read-1', name: 'read', arguments: {} }],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
    { role: 'toolResult', toolCallId: 'read-1', toolName: 'read', content, isError: false, timestamp: 3 },
  ] };
}

type WirePayload = { messages: Array<{ content: Array<{ type: string; content?: unknown[] }> }> };
function toolContent(request: WirePayload): unknown[] {
  const tool = request.messages.flatMap(message => message.content).find(block => block.type === 'tool_result');
  expect(tool).toBeDefined();
  return tool!.content!;
}

async function captureSdk(content: ToolResultMessage['content']) {
  const { stream } = await import('@earendil-works/pi-ai/api/anthropic-messages');
  let serialized: WirePayload | undefined;
  const sent: WirePayload[] = [];
  const response = await stream(model, sdkContext(content), {
    apiKey: 'offline-fixture-not-a-credential', maxRetries: 0,
    onPayload: async request => {
      serialized = structuredClone(request) as WirePayload;
      return transform(extensions(true), request);
    },
    // The real SDK encodes the final body; this transport never opens a socket.
    fetch: async (_input, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response('{"error":{"type":"invalid_request_error","message":"offline capture"}}',
        { status: 400, headers: { 'content-type': 'application/json' } });
    },
  }).result();
  expect(response.stopReason).toBe('error');
  expect(response.errorMessage).toContain('offline capture');
  expect(sent).toHaveLength(1);
  return { serialized: serialized!, sent: sent[0] };
}

test.each(['pure image', 'mixed'] as const)('real SDK offline payload: %s', async kind => {
  const imageBlock = { type: 'image' as const, mimeType: 'image/png', data: 'aW1hZ2U=' };
  const content: ToolResultMessage['content'] = kind === 'pure image'
    ? [imageBlock] : [{ type: 'text', text: 'first' }, imageBlock, { type: 'text', text: 'last' }];
  const { serialized, sent } = await captureSdk(content);
  const original = toolContent(serialized);
  expect(original[0]).toEqual(text(kind === 'pure image' ? '(see attached image)' : 'first'));
  const expected = structuredClone(serialized);
  const blocks = toolContent(expected);
  const isImage = (block: unknown) => (block as { type: string }).type === 'image';
  blocks.splice(0, blocks.length, ...blocks.filter(isImage), ...blocks.filter(block => !isImage(block)));
  expect(sent).toEqual(expected);
  expect(toolContent(sent)[0]).toEqual(image(imageBlock.data));
});
