// input: actual API URL and browser location
// output: credential transport policy and guarded fetch
// pos: transport safeguard for platform credential submissions
// >>> Once updated, update this header and parent CORTEX.md <<<

/** Evaluate the actual API destination, not the webview's local asset origin. */
export function safeCredentialTransport(serverUrl: string, pageUrl: string): boolean {
  try {
    const url = new URL(serverUrl || pageUrl);
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch { return false; }
}

export function credentialSafeFetch(serverUrl?: string): typeof fetch {
  return (input, init) => {
    const destination = requestDestination(input, serverUrl);
    if (!destination.includes('config.setPlatform')) return fetch(input, init);
    if (!safeCredentialTransport(destination, '')) {
      return Promise.reject(new Error('Platform credentials require HTTPS or loopback'));
    }
    return fetch(input, { ...init, redirect: 'error' });
  };
}

function requestDestination(input: RequestInfo | URL, serverUrl?: string): string {
  try {
    const url = typeof input === 'object' && 'url' in input ? input.url : String(input);
    return new URL(url, serverUrl || globalThis.location?.href).href;
  } catch { return ''; }
}
