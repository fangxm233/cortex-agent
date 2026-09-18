// input:  a turn's attachments (and the ones that failed to download)
// output: the prompt prefix the backend hands the model
// pos:    tests/agent-adapter — the filename the user chose has to survive into the prompt (the
//         stored path is an opaque, ASCII-folded, de-duplicated name), and a failed download has
//         to be admitted rather than silently omitted.
import { expect, test } from 'vitest';
import { buildPrompt, formatAttachmentFailures } from '../../src/agent-adapter/normalize/prompt-builder.js';

test('an attachment whose stored name differs from the user name carries both', () => {
  const prompt = buildPrompt('看看这个', [
    { mimeType: 'image/jpeg', path: '/tmp/attachments/in-feishu-1/_____.jpg', name: '季度报告.jpg' },
  ]);

  expect(prompt).toContain('/tmp/attachments/in-feishu-1/_____.jpg (季度报告.jpg)');
  expect(prompt).toContain('User sent 1 image(s)');
  expect(prompt.endsWith('看看这个')).toBe(true);
});

test('a failed download is named in the prompt with its reason', () => {
  const prompt = buildPrompt('这张图什么意思', [], [
    { name: 'img_v3_02n4.png', reason: 'Feishu resource fetch failed: 234003' },
  ]);

  expect(prompt).toContain('could NOT be downloaded');
  expect(prompt).toContain('img_v3_02n4.png (Feishu resource fetch failed: 234003)');
  expect(prompt.endsWith('这张图什么意思')).toBe(true);
});

test('a turn with neither files nor failures is left exactly as it was', () => {
  expect(buildPrompt('plain text', [])).toBe('plain text');
  expect(formatAttachmentFailures([])).toBe('');
});
