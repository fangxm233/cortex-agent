import { describe, expect, it } from 'vitest';
import { isAllowedMediaUrl, inlineMediaKind, isMediaUrl } from './inline-media-source';

describe('inline media URLs', () => {
  it.each([
    'http://example.com/a.png', 'data:image/png;base64,abc', 'javascript:alert(1)',
    'https://localhost/a', 'https://localhost./a', 'https://LOCALHOST/a',
    'https://camera.local/a', 'https://server.internal/a', 'https://camera/a',
    'https://0.0.0.0/a', 'https://127.0.0.1/a', 'https://127.1/a', 'https://2130706433/a',
    'https://10.1.2.3/a', 'https://172.16.0.1/a', 'https://172.31.255.255/a',
    'https://192.168.1.1/a', 'https://169.254.1.1/a', 'https://100.64.0.1/a', 'https://100.127.255.255/a',
    'https://[::1]/a', 'https://[::]/a', 'https://[fc00::1]/a', 'https://[fdff::1]/a',
    'https://[fe80::1]/a', 'https://[febf::1]/a', 'https://[::ffff:192.168.1.1]/a',
    '//example.com/a.png', '/home/a.png', 'not a URL',
  ])('blocks %s', (src) => expect(isAllowedMediaUrl(src)).toBe(false));

  it.each([
    'https://example.org/a.png', 'https://cdn.example.org/image?id=123',
    'https://8.8.8.8/a', 'https://172.15.0.1/a', 'https://172.32.0.1/a',
    'https://100.63.255.255/a', 'https://100.128.0.1/a', 'https://[2606:4700:4700::1111]/a',
  ])('allows %s', (src) => expect(isAllowedMediaUrl(src)).toBe(true));

  it('distinguishes device paths from URLs', () => {
    expect(isMediaUrl('my-pc:C:/Users/x/a.mp4')).toBe(false);
    expect(isMediaUrl('lab-ksu:/home/x/a.png')).toBe(false);
    expect(isMediaUrl('https://example.org/a.png')).toBe(true);
    expect(isMediaUrl('data:image/png;base64,abc')).toBe(true);
  });

  it('detects video extensions ignoring URL queries, and defaults to images', () => {
    expect(inlineMediaKind('https://example.org/a.MOV?q=.png')).toBe('video');
    expect(inlineMediaKind('my-pc:C:/Users/x/a.mp4')).toBe('video');
    expect(inlineMediaKind('https://example.org/image?id=1')).toBe('image');
  });
});
