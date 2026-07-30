// input:  FeishuAdapter and mocked Lark SDK calls
// output: Feishu messaging, reaction, card, file, and reply tests
// pos:    Verifies Feishu adapter platform mappings
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { FeishuAdapter } from '../src/platform/adapters/feishu.js';
import type { Destination } from '../src/platform/types.js';

function makeAdapter(): any {
  // Constructor only instantiates SDK clients; no network until start().
  return new FeishuAdapter({ appId: 'cli_test', appSecret: 'secret' }) as any;
}

// =========================================================================
// #6 — normalizeFormValues: type segment drives selectedOption vs value
// =========================================================================

test('Feishu normalizeFormValues: single-select → selectedOption', () => {
  const a = makeAdapter();
  const out = a.normalizeFormValues({ 'b1::a1::select': 'v2' });
  assert.deepEqual(out, { b1: { a1: { selectedOption: { value: 'v2' } } } });
});

test('Feishu normalizeFormValues: multi-select → selectedOptions', () => {
  const a = makeAdapter();
  const out = a.normalizeFormValues({ 'b1::a1::multi': ['x', 'y'] });
  assert.deepEqual(out, { b1: { a1: { selectedOptions: [{ value: 'x' }, { value: 'y' }] } } });
});

test('Feishu normalizeFormValues: text input → value', () => {
  const a = makeAdapter();
  const out = a.normalizeFormValues({ 'b1::a1::text': 'hello world' });
  assert.deepEqual(out, { b1: { a1: { value: 'hello world' } } });
});

test('Feishu normalizeFormValues: multi kind with scalar value still wraps as array', () => {
  const a = makeAdapter();
  const out = a.normalizeFormValues({ 'b1::a1::multi': 'solo' });
  assert.deepEqual(out, { b1: { a1: { selectedOptions: [{ value: 'solo' }] } } });
});

// =========================================================================
// #3 — extractInboundFiles: read resource key from parsed content
// =========================================================================

test('Feishu extractInboundFiles: image message', () => {
  const a = makeAdapter();
  const files = a.extractInboundFiles('image', { image_key: 'img_1' }, 'om_123');
  assert.equal(files.length, 1);
  assert.equal(files[0].id, 'img_1');
  assert.equal(files[0].mimetype, 'image/png');
  assert.deepEqual(files[0].raw, { message_id: 'om_123', resourceType: 'image' });
});

test('Feishu extractInboundFiles: file message carries name + file resourceType', () => {
  const a = makeAdapter();
  const files = a.extractInboundFiles('file', { file_key: 'file_1', file_name: 'report.pdf' }, 'om_9');
  assert.equal(files[0].id, 'file_1');
  assert.equal(files[0].name, 'report.pdf');
  assert.deepEqual(files[0].raw, { message_id: 'om_9', resourceType: 'file' });
});

test('Feishu extractInboundFiles: text message has no files', () => {
  const a = makeAdapter();
  assert.equal(a.extractInboundFiles('text', { text: 'hi' }, 'om_1'), undefined);
});

// =========================================================================
// post (富文本) — text+image mixed message: text must NOT be dropped, and
// inline images must be extracted as downloadable file refs.
// =========================================================================

// A real Feishu `post` receive payload: content is a 2D array of paragraphs.
const POST_TEXT_AND_IMAGE = {
  title: '',
  content: [
    [
      { tag: 'text', text: 'look at this ' },
      { tag: 'a', text: 'link', href: 'https://x' },
    ],
    [
      { tag: 'img', image_key: 'img_post_1' },
    ],
  ],
};

test('Feishu parsePostContent: extracts text + image_keys from mixed post', () => {
  const a = makeAdapter();
  const { text, imageKeys } = a.parsePostContent(POST_TEXT_AND_IMAGE);
  assert.equal(text, 'look at this link');
  assert.deepEqual(imageKeys, ['img_post_1']);
});

test('Feishu parsePostContent: prefixes a non-empty title and renders @mentions', () => {
  const a = makeAdapter();
  const { text } = a.parsePostContent({
    title: 'Heads up',
    content: [[{ tag: 'at', user_name: 'Fang' }, { tag: 'text', text: ' please review' }]],
  });
  assert.equal(text, 'Heads up\n@Fang please review');
});

test('Feishu extractInboundFiles: post message yields one file ref per inline image', () => {
  const a = makeAdapter();
  const files = a.extractInboundFiles('post', POST_TEXT_AND_IMAGE, 'om_post', 'oc_chat');
  assert.equal(files.length, 1);
  assert.equal(files[0].id, 'img_post_1');
  assert.equal(files[0].mimetype, 'image/png');
  assert.deepEqual(files[0].raw, { message_id: 'om_post', resourceType: 'image' });
});

test('Feishu extractInboundFiles: text-only post has no files', () => {
  const a = makeAdapter();
  const post = { content: [[{ tag: 'text', text: 'just text' }]] };
  assert.equal(a.extractInboundFiles('post', post, 'om_1', 'oc_1'), undefined);
});

test('Feishu handleIncomingMessage: mixed text+image post delivers text AND file (regression)', async () => {
  const a = makeAdapter();
  a.config.adminChannel = 'oc_known'; // suppress admin auto-detect side effects
  let received: any = null;
  a.onMessage(async (ctx: any) => { received = ctx.message; });

  await a.handleIncomingMessage({
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_user' } },
    message: {
      chat_id: 'oc_known',
      chat_type: 'group',
      message_id: 'om_post',
      message_type: 'post',
      content: JSON.stringify(POST_TEXT_AND_IMAGE),
    },
  });

  assert.ok(received, 'message handler should have been invoked');
  assert.equal(received.text, 'look at this link', 'text must not be empty for mixed post');
  assert.equal(received.kind, 'file_share');
  assert.equal(received.files.length, 1);
  assert.equal(received.files[0].id, 'img_post_1');
});

// =========================================================================
// Quote/reply enrichment — a reply pulls its directly-quoted parent (one level)
// so a file shared via reply-and-@ (file messages carry no text, cannot @ the
// bot) is not lost. Unconditional, parent-bot included, single level.
// message.get returns content under data.items[].body.content (a JSON string).
// =========================================================================

function makeReplyInbound(parentId: string, replyText = '处理这个', senderType = 'user') {
  return {
    sender: { sender_type: senderType, sender_id: { open_id: 'ou_user' } },
    message: {
      chat_id: 'oc_known',
      chat_type: 'group',
      message_id: 'om_reply',
      parent_id: parentId,
      message_type: 'text',
      content: JSON.stringify({ text: replyText }),
    },
  };
}

test('Feishu handleIncomingMessage: reply pulls quoted parent FILE into files (download targets parent id)', async () => {
  const a = makeAdapter();
  a.config.adminChannel = 'oc_known';
  let askedId: string | null = null;
  a.client = { im: { v1: { message: { get: async (req: any) => {
    askedId = req.path.message_id;
    return { data: { items: [{
      message_id: 'om_file_parent',
      msg_type: 'file',
      body: { content: JSON.stringify({ file_key: 'file_xyz', file_name: 'data.csv' }) },
    }] } };
  } } } } };
  let received: any = null;
  a.onMessage(async (ctx: any) => { received = ctx.message; });

  await a.handleIncomingMessage(makeReplyInbound('om_file_parent'));

  assert.equal(askedId, 'om_file_parent', 'fetches the parent_id, one level');
  assert.equal(received.kind, 'file_share');
  assert.equal(received.files.length, 1);
  assert.equal(received.files[0].id, 'file_xyz');
  assert.equal(received.files[0].name, 'data.csv');
  // download must hit the PARENT message id, not the reply
  assert.deepEqual(received.files[0].raw, { message_id: 'om_file_parent', resourceType: 'file' });
  assert.equal(received.text, '处理这个', 'parent file has no text; reply text unchanged');
});

test('Feishu handleIncomingMessage: reply appends quoted parent TEXT under a marker', async () => {
  const a = makeAdapter();
  a.config.adminChannel = 'oc_known';
  a.client = { im: { v1: { message: { get: async () => ({ data: { items: [{
    message_id: 'om_text_parent',
    msg_type: 'text',
    body: { content: JSON.stringify({ text: '原始问题内容' }) },
  }] } }) } } } };
  let received: any = null;
  a.onMessage(async (ctx: any) => { received = ctx.message; });

  await a.handleIncomingMessage(makeReplyInbound('om_text_parent', '请回答'));

  assert.ok(received.text.includes('请回答'), 'keeps the reply text');
  assert.ok(received.text.includes('原始问题内容'), 'appends quoted parent text');
  assert.equal(received.kind, 'user', 'no files → still a plain user message');
});

test('Feishu handleIncomingMessage: quoted parent that is a bot message is still pulled (unconditional)', async () => {
  const a = makeAdapter();
  a.config.adminChannel = 'oc_known';
  let getCalled = false;
  a.client = { im: { v1: { message: { get: async () => {
    getCalled = true;
    return { data: { items: [{
      message_id: 'om_bot_parent',
      msg_type: 'post',
      body: { content: JSON.stringify({ content: [[{ tag: 'text', text: '机器人之前的回答' }]] }) },
    }] } };
  } } } } };
  let received: any = null;
  a.onMessage(async (ctx: any) => { received = ctx.message; });

  await a.handleIncomingMessage(makeReplyInbound('om_bot_parent', '继续'));

  assert.equal(getCalled, true, 'parent fetched even though it is a bot message');
  assert.ok(received.text.includes('机器人之前的回答'));
});

test('Feishu handleIncomingMessage: quoted-parent fetch failure is non-fatal', async () => {
  const a = makeAdapter();
  a.config.adminChannel = 'oc_known';
  a.client = { im: { v1: { message: { get: async () => { throw new Error('permission denied'); } } } } };
  let received: any = null;
  a.onMessage(async (ctx: any) => { received = ctx.message; });

  await a.handleIncomingMessage(makeReplyInbound('om_missing', 'hello'));

  assert.ok(received, 'handler still invoked despite fetch error');
  assert.equal(received.text, 'hello');
  assert.equal(received.files, undefined);
});

test('Feishu handleIncomingMessage: no parent_id never calls message.get', async () => {
  const a = makeAdapter();
  a.config.adminChannel = 'oc_known';
  let getCalled = false;
  a.client = { im: { v1: { message: { get: async () => { getCalled = true; return { data: { items: [] } }; } } } } };
  a.onMessage(async () => {});

  await a.handleIncomingMessage({
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_user' } },
    message: {
      chat_id: 'oc_known', chat_type: 'group', message_id: 'om_1',
      message_type: 'text', content: JSON.stringify({ text: 'hi' }),
    },
  });

  assert.equal(getCalled, false, 'a non-reply message must not trigger a parent fetch');
});

// =========================================================================
// #1/#2 — project-report routing resolves through the conduit store
// =========================================================================

test('Feishu resolveDestination: project-report uses bound conduit', async () => {
  const a = makeAdapter();
  // resolveDestination reads the bare chat_id directly via store.get().
  a._conduitsStore = {
    get: async (id: string) => (id === 'proj1' ? 'oc_bound' : null),
    getAll: async () => ({ proj1: 'oc_bound' }),
  };
  const dest: Destination = { type: 'project-report', projectId: 'proj1', trigger: 't' };
  const r = await a.resolveDestination(dest);
  assert.deepEqual(r, { channel: 'oc_bound', kind: 'project-report' });
});

test('Feishu resolveDestination: unbound project-report falls back to admin DM when configured', async () => {
  const a = makeAdapter();
  a._conduitsStore = { get: async () => null, getAll: async () => ({}) };
  a.config.adminChannel = 'oc_admin';
  const dest: Destination = { type: 'project-report', projectId: 'missing', trigger: 't' };
  const r = await a.resolveDestination(dest);
  assert.equal(r.channel, 'oc_admin');
  assert.equal(r.kind, 'project-report-dm');
});

test('Feishu resolveDestination: unbound project-report dropped when no admin channel', async () => {
  const a = makeAdapter();
  a._conduitsStore = { get: async () => null, getAll: async () => ({}) };
  // config.adminChannel is undefined (makeAdapter sets only appId/appSecret)
  const dest: Destination = { type: 'project-report', projectId: 'missing', trigger: 't' };
  const r = await a.resolveDestination(dest);
  assert.equal(r.channel, null);
  assert.equal(r.kind, 'project-report-noop');
});

// =========================================================================
// #6b — form submit routes to the handler registered under callbackId
// (submit button name === callbackId; action.name carries the button name)
// =========================================================================

test('Feishu handleCardAction: form submit reaches the modal handler with normalized values', async () => {
  const a = makeAdapter();
  const callbackId = 'ask_user_question_modal_submit';
  let received: any = null;
  a.onModalSubmit(callbackId, async (ctx: any) => { received = ctx; await ctx.ack(); });

  // Simulate the card.action.trigger event Feishu sends on form submit:
  // action.name is the submit button's name (which we set to callbackId).
  const ret = await a.handleCardAction({
    event: {
      operator: { open_id: 'ou_user' },
      context: { open_chat_id: 'oc_1', open_message_id: 'om_1' },
      action: {
        tag: 'button',
        name: callbackId,
        value: { groupId: 'g1' },
        form_value: { 'b1::a1::select': 'v2', 'b2::a2::text': 'hi' },
      },
    },
  });

  assert.ok(received, 'modal handler should have been invoked');
  assert.equal(received.callbackId, callbackId);
  assert.deepEqual(received.values.b1.a1, { selectedOption: { value: 'v2' } });
  assert.deepEqual(received.values.b2.a2, { value: 'hi' });
  assert.deepEqual(ret, { toast: { type: 'success', content: 'OK' } });
});

// =========================================================================
// #5 — replyInThread returns a non-empty conduit
// =========================================================================

test('Feishu postMessage in thread returns resolved conduit', async () => {
  const a = makeAdapter();
  a.client = {
    im: { v1: { message: { reply: async () => ({ data: { message_id: 'om_reply' } }) } } },
  };
  // interactive-reply may carry the prefixed conduit; the returned ref is also
  // exposed in canonical prefixed form (`feishu:oc_chat`).
  const dest: Destination = { type: 'interactive-reply', conduit: 'feishu:oc_chat', sessionId: '' };
  const ref = await a.postMessage(dest, { text: 'hi' }, { threadId: 'om_root' });
  assert.equal(ref.conduit, 'feishu:oc_chat');
  assert.equal(ref.messageId, 'om_reply');
  assert.equal(ref.threadId, 'om_root');
});

test('Feishu replyInThread sets reply_in_thread:true (real 话题 thread)', async () => {
  const a = makeAdapter();
  let seen: any = null;
  a.client = {
    im: { v1: { message: { reply: async (payload: any) => { seen = payload; return { data: { message_id: 'om_reply' } }; } } } },
  };
  const dest: Destination = { type: 'interactive-reply', conduit: 'feishu:oc_chat', sessionId: '' };
  await a.postMessage(dest, { text: 'hi' }, { threadId: 'om_root' });
  assert.equal(seen.data.reply_in_thread, true);
  assert.equal(seen.path.message_id, 'om_root');
});

test('Feishu replyInThread falls back to plain reply when chat rejects threads (230071)', async () => {
  const a = makeAdapter();
  const calls: boolean[] = [];
  a.client = {
    im: { v1: { message: { reply: async (payload: any) => {
      calls.push(payload.data.reply_in_thread);
      if (payload.data.reply_in_thread) {
        const err: any = new Error('thread not supported');
        err.response = { data: { code: 230071 } };
        throw err;
      }
      return { data: { message_id: 'om_plain' } };
    } } } },
  };
  const dest: Destination = { type: 'interactive-reply', conduit: 'feishu:oc_chat', sessionId: '' };
  const ref = await a.postMessage(dest, { text: 'hi' }, { threadId: 'om_root' });
  assert.deepEqual(calls, [true, false], 'tries thread first, then plain reply');
  assert.equal(ref.messageId, 'om_plain');
});

// =========================================================================
// Admin channel auto-detection from the first p2p (DM) message
// =========================================================================

function makeInbound(chatType: string, chatId: string, senderType = 'user') {
  return {
    sender: { sender_type: senderType, sender_id: { open_id: 'ou_user' } },
    message: {
      chat_id: chatId,
      chat_type: chatType,
      message_id: 'om_1',
      message_type: 'text',
      content: JSON.stringify({ text: 'hello' }),
    },
  };
}

test('Feishu admin auto-detect: first p2p DM registers + persists admin chat_id', async () => {
  delete process.env.FEISHU_ADMIN_CHANNEL;
  const a = makeAdapter();
  let persisted: string | null = null;
  let noticeText: string | null = null;
  a._persistAdminChannel = async (id: string) => { persisted = id; };
  a.postMessage = async (_dest: Destination, content: any) => { noticeText = content.text; return { conduit: '', messageId: '' }; };
  a.onMessage(async () => {});

  await a.handleIncomingMessage(makeInbound('p2p', 'oc_admin'));

  assert.equal(a.config.adminChannel, 'oc_admin');
  assert.equal(process.env.FEISHU_ADMIN_CHANNEL, 'oc_admin');
  assert.equal(persisted, 'oc_admin');
  assert.ok(noticeText && noticeText.includes('oc_admin'));
  delete process.env.FEISHU_ADMIN_CHANNEL;
});

test('Feishu admin auto-detect: only fires once', async () => {
  delete process.env.FEISHU_ADMIN_CHANNEL;
  const a = makeAdapter();
  let persistCount = 0;
  a._persistAdminChannel = async () => { persistCount++; };
  a.postMessage = async () => ({ conduit: '', messageId: '' });
  a.onMessage(async () => {});

  await a.handleIncomingMessage(makeInbound('p2p', 'oc_first'));
  await a.handleIncomingMessage(makeInbound('p2p', 'oc_second'));

  assert.equal(a.config.adminChannel, 'oc_first');
  assert.equal(persistCount, 1);
  delete process.env.FEISHU_ADMIN_CHANNEL;
});

// =========================================================================
// Card schema 2.0: action buttons must NOT use the removed `action` tag
// (Feishu err 200861 "unsupported tag action"); use column_set + behaviors.
// =========================================================================

test('Feishu buildCardJson: actions render as column_set buttons (no `action` tag)', () => {
  const a = makeAdapter();
  const card = a.buildCardJson({
    text: 'processing',
    richBlocks: [
      { type: 'section', text: 'Processing…', format: 'markdown' },
      { type: 'actions', elements: [
        { type: 'button', text: 'Cancel', actionId: 'status_cancel', value: '{}', style: 'danger' },
        { type: 'button', text: 'New', actionId: 'status_new', value: 'oc_x' },
      ] },
    ],
  });
  assert.equal(card.schema, '2.0');
  const tags = card.body.elements.map((e: any) => e.tag);
  assert.ok(!tags.includes('action'), 'must not emit the removed `action` container tag');
  assert.ok(tags.includes('column_set'), 'buttons render via column_set');

  // Schema 2.0 also removed `note`: context blocks must render as markdown.
  const withCtx = a.buildCardJson({
    text: 'x',
    richBlocks: [
      { type: 'section', text: 'Q' },
      { type: 'context', text: 'opt1 · opt2' },
      { type: 'divider' },
    ],
  });
  const ctxTags = withCtx.body.elements.map((e: any) => e.tag);
  assert.ok(!ctxTags.includes('note'), 'must not emit the removed `note` tag');
  assert.ok(ctxTags.includes('markdown'), 'context renders as markdown');
  assert.ok(ctxTags.includes('hr'), 'divider renders as hr');
  const colset = card.body.elements.find((e: any) => e.tag === 'column_set');
  assert.equal(colset.columns.length, 2);
  // flow + auto-width so buttons wrap and stay readable (not crushed into one row).
  assert.equal(colset.flex_mode, 'flow');
  assert.equal(colset.columns[0].width, 'auto');
  const btn = colset.columns[0].elements[0];
  assert.equal(btn.tag, 'button');
  assert.equal(btn.name, 'status_cancel');
  assert.equal(btn.type, 'danger');
  // Callback payload travels via behaviors (schema 2.0), readable as action.value.
  assert.deepEqual(btn.behaviors, [{ type: 'callback', value: { actionId: 'status_cancel', value: '{}' } }]);
});

test('Feishu buildCardJson: cards carry config.update_multi so post-interaction updates persist', () => {
  const a = makeAdapter();
  const card = a.buildCardJson({ text: 'x', richBlocks: [{ type: 'section', text: 'Q' }] });
  // Without update_multi the Feishu client rolls a card back to its pre-click state
  // after a button callback (the "approved then reverts" bug).
  assert.equal(card.config?.update_multi, true);
});

test('Feishu postInteractive: standalone card carries config.update_multi', async () => {
  const a = makeAdapter();
  let seen: any = null;
  a.client = {
    im: { v1: { message: { create: async (payload: any) => { seen = payload; return { data: { message_id: 'om_card' } }; } } } },
  };
  const dest: Destination = { type: 'interactive-reply', conduit: 'feishu:oc_chat', sessionId: '' };
  await a.postInteractive(dest, {
    text: 'Plan approval',
    actions: [{ type: 'button', text: 'Approve', actionId: 'hook_plan_approve', value: 'req1' }],
  });
  const card = JSON.parse(seen.data.content);
  assert.equal(card.config?.update_multi, true);
});

test('Feishu postInteractive: threaded card uses reply_in_thread:true (lands in 话题)', async () => {
  const a = makeAdapter();
  let seen: any = null;
  a.client = {
    im: { v1: { message: { reply: async (payload: any) => { seen = payload; return { data: { message_id: 'om_reply' } }; } } } },
  };
  const dest: Destination = { type: 'interactive-reply', conduit: 'feishu:oc_chat', sessionId: '' };
  const ref = await a.postInteractive(dest, {
    text: 'Plan approval',
    actions: [{ type: 'button', text: 'Approve', actionId: 'hook_plan_approve', value: 'req1' }],
  }, { threadId: 'om_root' });
  assert.equal(seen.path.message_id, 'om_root');
  assert.equal(seen.data.reply_in_thread, true, 'card must collect into the topic, not inline quote');
  assert.equal(ref.threadId, 'om_root');
});

test('Feishu postInteractive: threaded card falls back to plain reply when chat rejects threads (230071)', async () => {
  const a = makeAdapter();
  const calls: boolean[] = [];
  a.client = {
    im: { v1: { message: { reply: async (payload: any) => {
      calls.push(payload.data.reply_in_thread);
      if (payload.data.reply_in_thread) {
        const err: any = new Error('thread not supported');
        err.response = { data: { code: 230071 } };
        throw err;
      }
      return { data: { message_id: 'om_plain' } };
    } } } },
  };
  const dest: Destination = { type: 'interactive-reply', conduit: 'feishu:oc_chat', sessionId: '' };
  const ref = await a.postInteractive(dest, {
    text: 'Plan approval',
    actions: [{ type: 'button', text: 'Approve', actionId: 'hook_plan_approve', value: 'req1' }],
  }, { threadId: 'om_root' });
  assert.deepEqual(calls, [true, false], 'tries thread first, then plain reply');
  assert.equal(ref.messageId, 'om_plain');
});

test('Feishu buildMessagePayload: text-only renders as a markdown card (not plain text)', () => {
  const a = makeAdapter();
  const { msgType, msgContent } = a.buildMessagePayload({ text: '**bold** and `code`' });
  assert.equal(msgType, 'interactive');
  const card = JSON.parse(msgContent);
  assert.equal(card.schema, '2.0');
  assert.deepEqual(card.body.elements, [{ tag: 'markdown', content: '**bold** and `code`' }]);
});

test('Feishu modalToFeishuCard: form name is distinct from submit button name (no duplicate)', () => {
  const a = makeAdapter();
  const card = a.modalToFeishuCard({
    title: 'Q', callbackId: 'cb_ask', submitLabel: 'Submit',
    fields: [
      { type: 'select', blockId: 'q1', actionId: 'a1', options: [{ label: 'A', value: 'a' }] },
    ],
  });
  const form = card.body.elements[0];
  assert.equal(form.tag, 'form');
  const submit = form.elements.find((e: any) => e.tag === 'button' && e.action_type === 'form_submit');
  // Submit button name MUST equal callbackId (it arrives as event.action.name);
  // the form container name MUST differ, or Feishu rejects the card (err 11310).
  assert.equal(submit.name, 'cb_ask');
  assert.notEqual(form.name, submit.name);
});

test('Feishu modalToFeishuCard: submit button carries privateMetadata as value (groupId round-trip)', () => {
  const a = makeAdapter();
  const card = a.modalToFeishuCard({
    title: 'Q', callbackId: 'ask_user_question_modal_submit',
    privateMetadata: JSON.stringify({ groupId: 'sid:rid' }),
    fields: [{ type: 'select', blockId: 'q_0', actionId: 'selection', options: [{ label: 'A', value: '0' }] }],
  });
  const form = card.body.elements[0];
  const submit = form.elements.find((e: any) => e.action_type === 'form_submit');
  // value arrives as event.action.value → privateMetadata → groupId in handleModalSubmit.
  assert.deepEqual(submit.value, { groupId: 'sid:rid' });
  // behaviors must NOT be present: it's mutually exclusive with form_submit in Feishu 2.0.
  assert.equal(submit.behaviors, undefined);
});

test('Feishu queue marker stores create reaction_id, deletes that exact OnIt reaction, and marks it consumed', async () => {
  const a = makeAdapter();
  const calls: Array<{ op: string; payload: any }> = [];
  a.client = { im: { v1: { messageReaction: {
    create: async (payload: any) => {
      calls.push({ op: 'create', payload });
      return { data: { reaction_id: 'react-7' } };
    },
    delete: async (payload: any) => { calls.push({ op: 'delete', payload }); },
  } } } };
  const ref = { conduit: 'feishu:oc_7', messageId: 'om_7' };

  await a.markQueued(ref);
  await a.unmarkQueued(ref);

  assert.deepEqual(calls, [
    {
      op: 'create',
      payload: {
        path: { message_id: 'om_7' },
        data: { reaction_type: { emoji_type: 'OnIt' } },
      },
    },
    {
      op: 'delete',
      payload: { path: { message_id: 'om_7', reaction_id: 'react-7' } },
    },
    {
      op: 'create',
      payload: {
        path: { message_id: 'om_7' },
        data: { reaction_type: { emoji_type: 'CheckMark' } },
      },
    },
  ]);
});

test('Feishu marks a message consumed even when no queued reaction id was ever stored', async () => {
  const a = makeAdapter();
  const created: string[] = [];
  a.client = { im: { v1: { messageReaction: {
    create: async (payload: any) => {
      created.push(payload.data.reaction_type.emoji_type);
      return { data: {} };
    },
    delete: async () => { assert.fail('nothing to delete without a stored reaction id'); },
  } } } };

  await a.unmarkQueued({ conduit: 'feishu:oc_7', messageId: 'om_7' });

  assert.deepEqual(created, ['CheckMark']);
});

test('Feishu marker add/remove stay best-effort when the SDK rejects', async () => {
  const ref = { conduit: 'feishu:oc_7', messageId: 'om_7' };
  const addFailure = makeAdapter();
  addFailure.client = { im: { v1: { messageReaction: {
    create: async () => { throw new Error('add denied'); },
  } } } };
  await assert.doesNotReject(addFailure.markQueued(ref));

  const removeFailure = makeAdapter();
  let deleteCalls = 0;
  removeFailure.client = { im: { v1: { messageReaction: {
    create: async () => ({ data: { reaction_id: 'react-8' } }),
    delete: async () => { deleteCalls++; throw new Error('delete denied'); },
  } } } };
  await removeFailure.markQueued(ref);
  await assert.doesNotReject(removeFailure.unmarkQueued(ref));
  await removeFailure.unmarkQueued(ref);
  assert.equal(deleteCalls, 1, 'failed removal still clears local state instead of leaking');
});

test('Feishu admin auto-detect: group messages do not register an admin channel', async () => {
  delete process.env.FEISHU_ADMIN_CHANNEL;
  const a = makeAdapter();
  a._persistAdminChannel = async () => {};
  a.postMessage = async () => ({ conduit: '', messageId: '' });
  a.onMessage(async () => {});

  await a.handleIncomingMessage(makeInbound('group', 'oc_group'));

  assert.equal(a.config.adminChannel, undefined);
  assert.equal(process.env.FEISHU_ADMIN_CHANNEL, undefined);
});
