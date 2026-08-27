// input:  Mock XHR events, Unicode files, desktop auth config, and abort signals
// output: Upload wire, progress, stable HTTP/network errors, and pre-abort regressions
// pos:    Shared attachment transport specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uploadAttachment } from './upload-attachment';
import type { AttachmentMeta } from './types';

type Handler = (event: any) => void;

class MockTarget {
  handlers = new Map<string, Handler[]>();

  addEventListener(name: string, handler: Handler): void {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]);
  }

  emit(name: string, event: any = {}): void {
    this.handlers.get(name)?.forEach((handler) => handler(event));
  }
}

class MockXHR extends MockTarget {
  static instances: MockXHR[] = [];
  upload = new MockTarget();
  headers: Record<string, string> = {};
  status = 0;
  response: unknown = null;
  responseType = '';
  method = '';
  url = '';
  body: unknown;

  constructor() {
    super();
    MockXHR.instances.push(this);
  }

  open(method: string, url: string): void { this.method = method; this.url = url; }
  setRequestHeader(key: string, value: string): void { this.headers[key] = value; }
  send(body: unknown): void { this.body = body; }
  abort(): void { this.emit('abort'); }
}

const META: AttachmentMeta = {
  name: '雪景.png', path: 'attachments/s1/snow.png', size: 4, mimeType: 'image/png', type: 'image',
};

beforeEach(() => {
  MockXHR.instances = [];
  vi.stubGlobal('XMLHttpRequest', MockXHR);
  (globalThis as any).__CORTEX_DESKTOP_CONFIG = { serverUrl: 'https://host.example', token: 'secret' };
});

afterEach(() => {
  delete (globalThis as any).__CORTEX_DESKTOP_CONFIG;
  vi.unstubAllGlobals();
});

describe('uploadAttachment', () => {
  it('sends authenticated Unicode-safe headers and reports progress', async () => {
    const progress = vi.fn();
    const file = new File(['data'], '雪 景.png', { type: 'image/png' });
    const pending = uploadAttachment(file, 'bucket-一', progress, new AbortController().signal);
    const xhr = MockXHR.instances[0];

    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe('https://host.example/api/attachments/upload');
    expect(xhr.headers).toMatchObject({
      'X-Session-Id': 'bucket-一',
      'X-File-Name': encodeURIComponent('雪 景.png'),
      'Content-Type': 'image/png',
      'x-cortex-token': 'secret',
    });
    xhr.upload.emit('progress', { lengthComputable: true, loaded: 2, total: 4 });
    xhr.status = 201;
    xhr.response = { ok: true, data: META };
    xhr.emit('load');

    await expect(pending).resolves.toEqual(META);
    expect(progress).toHaveBeenCalledWith(50);
    expect(xhr.body).toBe(file);
  });

  it('maps 413 independently of the response body', async () => {
    const pending = uploadAttachment(new File(['x'], 'big.bin'), 's1', () => {}, new AbortController().signal);
    const xhr = MockXHR.instances[0];
    xhr.status = 413;
    xhr.response = { message: 'proxy wording' };
    xhr.emit('load');
    await expect(pending).rejects.toThrow('File too large');
  });

  it('reports a stable network error', async () => {
    const pending = uploadAttachment(new File(['x'], 'a.bin'), 's1', () => {}, new AbortController().signal);
    MockXHR.instances[0].emit('error');
    await expect(pending).rejects.toThrow('Network error');
  });

  it('does not construct or send XHR for a pre-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const pending = uploadAttachment(new File(['x'], 'a.bin'), 's1', () => {}, controller.signal);
    await expect(pending).rejects.toThrow('Upload cancelled');
    expect(MockXHR.instances).toHaveLength(0);
  });
});
