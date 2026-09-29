import { test } from 'vitest';
import assert from 'node:assert/strict';
import { uploadFileToFeishu } from '../../../src/domain/mcp/feishu/file.js';

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
