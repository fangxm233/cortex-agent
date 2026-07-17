// input:  uploadFileToFeishu function, FEISHU_CHANNEL with platform prefix
// output: uploadFileToFeishu correctly strips 'feishu:' prefix before calling Feishu API
// pos:    regression test for channel ID prefix handling
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { uploadFileToFeishu } from '../../../src/domain/mcp/feishu/file.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Mock Feishu client for testing
class MockFeishuClient {
  private recordedCalls: Array<{ method: string; args: any }> = [];
  readonly im = {
    v1: {
      file: {
        create: async (args: any) => {
          this.recordedCalls.push({ method: 'im.v1.file.create', args });
          return {
            code: 0,
            data: {
              file_key: 'test-file-key-123',
            },
          };
        },
      },
      message: {
        create: async (args: any) => {
          this.recordedCalls.push({ method: 'im.v1.message.create', args });
          return { code: 0, data: {} };
        },
      },
    },
  };

  getRecordedCalls() {
    return this.recordedCalls;
  }
}

test('uploadFileToFeishu strips feishu: prefix from channel ID before API calls', async (t) => {
  // Create a temporary test file
  const testFile = path.join(__dirname, 'test-feishu-upload.txt');
  fs.writeFileSync(testFile, 'test content for feishu');

  try {
    // Create mock Feishu client
    const mockClient = new MockFeishuClient() as any;

    // Call with channel that has 'feishu:' prefix
    const result = await uploadFileToFeishu(mockClient, {
      channel: 'feishu:oc_123abc',
      filePath: testFile,
      title: 'Test File',
    });

    // Verify the result
    assert.equal(result.fileName, 'test-feishu-upload.txt');
    assert.equal(result.size, 23);

    // Verify that API calls received the bare channel ID (without 'feishu:' prefix)
    const calls = mockClient.getRecordedCalls();
    const createCall = calls.find((c: any) => c.method === 'im.v1.message.create');

    if (createCall) {
      assert.equal(
        createCall.args.data.receive_id,
        'oc_123abc',
        'im.v1.message.create should receive bare channel ID without feishu: prefix'
      );
    }
  } finally {
    // Clean up test file
    if (fs.existsSync(testFile)) {
      fs.unlinkSync(testFile);
    }
  }
});

test('uploadFileToFeishu works with bare channel ID (no prefix)', async (t) => {
  // Create a temporary test file
  const testFile = path.join(__dirname, 'test-feishu-upload-bare.txt');
  fs.writeFileSync(testFile, 'test content for feishu');

  try {
    // Create mock Feishu client
    const mockClient = new MockFeishuClient() as any;

    // Call with bare channel ID (should also work)
    const result = await uploadFileToFeishu(mockClient, {
      channel: 'oc_123abc',
      filePath: testFile,
      title: 'Test File',
    });

    // Verify the result
    assert.equal(result.fileName, 'test-feishu-upload-bare.txt');
    assert.equal(result.size, 23);

    // Verify that API calls received the bare channel ID
    const calls = mockClient.getRecordedCalls();
    const createCall = calls.find((c: any) => c.method === 'im.v1.message.create');

    if (createCall) {
      assert.equal(
        createCall.args.data.receive_id,
        'oc_123abc',
        'im.v1.message.create should receive channel ID as-is'
      );
    }
  } finally {
    // Clean up test file
    if (fs.existsSync(testFile)) {
      fs.unlinkSync(testFile);
    }
  }
});

test('uploadFileToFeishu throws on file not found', async (t) => {
  const mockClient = new MockFeishuClient() as any;

  try {
    await uploadFileToFeishu(mockClient, {
      channel: 'feishu:oc_123abc',
      filePath: '/nonexistent/file.txt',
      title: 'Test',
    });
    assert.fail('Should have thrown error');
  } catch (e) {
    assert.ok((e as Error).message.includes('File not found'));
  }
});
