// input:  uploadFileToSlack function, SLACK_CHANNEL with platform prefix
// output: uploadFileToSlack correctly strips 'slack:' prefix before calling Slack API
// pos:    regression test for channel ID prefix handling
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { uploadFileToSlack } from '../../../src/domain/mcp/tools/slack.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Mock WebClient for testing
class MockWebClient {
  private recordedCalls: Array<{ method: string; args: any }> = [];
  readonly chat = {
    postMessage: async (args: any) => {
      this.recordedCalls.push({ method: 'chat.postMessage', args });
      return { ok: true };
    },
  };
  readonly files = {
    getUploadURLExternal: async (args: any) => {
      this.recordedCalls.push({ method: 'files.getUploadURLExternal', args });
      return {
        upload_url: 'https://example.com/upload',
        file_id: 'test-file-id',
      };
    },
    completeUploadExternal: async (args: any) => {
      this.recordedCalls.push({ method: 'files.completeUploadExternal', args });
      return { ok: true };
    },
  };

  getRecordedCalls() {
    return this.recordedCalls;
  }
}

// Minimal mock to intercept fetch
const originalFetch = globalThis.fetch;
let mockFetch: ((url: string, init?: any) => Promise<Response>) | null = null;

test('uploadFileToSlack strips slack: prefix from channel ID before API calls', async (t) => {
  // Create a temporary test file
  const testFile = path.join(__dirname, 'test-upload.txt');
  fs.writeFileSync(testFile, 'test content');

  try {
    // Mock fetch to intercept the actual file upload
    globalThis.fetch = (async (url: string, init?: any) => {
      return new Response('', { status: 200, statusText: 'OK' });
    }) as any;

    // Create mock WebClient
    const mockClient = new MockWebClient() as any;

    // Call with channel that has 'slack:' prefix (this is what SLACK_CHANNEL env var provides)
    const result = await uploadFileToSlack(mockClient, {
      channel: 'slack:C0AHP98657C',
      filePath: testFile,
      title: 'Test File',
    });

    // Verify the result
    assert.equal(result.fileName, 'test-upload.txt');
    assert.equal(result.size, 12);

    // Verify that API calls received the bare channel ID (without 'slack:' prefix)
    const calls = mockClient.getRecordedCalls();
    const postMessageCall = calls.find((c: any) => c.method === 'chat.postMessage');
    const completeCall = calls.find((c: any) => c.method === 'files.completeUploadExternal');

    if (postMessageCall) {
      assert.equal(
        postMessageCall.args.channel,
        'C0AHP98657C',
        'chat.postMessage should receive bare channel ID without slack: prefix'
      );
    }

    if (completeCall) {
      assert.equal(
        completeCall.args.channel_id,
        'C0AHP98657C',
        'files.completeUploadExternal should receive bare channel ID without slack: prefix'
      );
    }
  } finally {
    // Restore original fetch
    globalThis.fetch = originalFetch;
    // Clean up test file
    if (fs.existsSync(testFile)) {
      fs.unlinkSync(testFile);
    }
  }
});

test('uploadFileToSlack works with bare channel ID (no prefix)', async (t) => {
  // Create a temporary test file
  const testFile = path.join(__dirname, 'test-upload-bare.txt');
  fs.writeFileSync(testFile, 'test content');

  try {
    // Mock fetch
    globalThis.fetch = (async (url: string, init?: any) => {
      return new Response('', { status: 200, statusText: 'OK' });
    }) as any;

    // Create mock WebClient
    const mockClient = new MockWebClient() as any;

    // Call with bare channel ID (should also work)
    const result = await uploadFileToSlack(mockClient, {
      channel: 'C0AHP98657C',
      filePath: testFile,
      title: 'Test File',
    });

    // Verify the result
    assert.equal(result.fileName, 'test-upload-bare.txt');
    assert.equal(result.size, 12);

    // Verify that API calls received the bare channel ID
    const calls = mockClient.getRecordedCalls();
    const completeCall = calls.find((c: any) => c.method === 'files.completeUploadExternal');

    if (completeCall) {
      assert.equal(
        completeCall.args.channel_id,
        'C0AHP98657C',
        'files.completeUploadExternal should receive channel ID as-is'
      );
    }
  } finally {
    // Restore original fetch
    globalThis.fetch = originalFetch;
    // Clean up test file
    if (fs.existsSync(testFile)) {
      fs.unlinkSync(testFile);
    }
  }
});
