export function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status });
}

export function notFound(): Response {
  return jsonResponse(404, { error: 'not found' });
}

export function methodNotAllowed(method: string): Response {
  return new Response(null, { status: 405, headers: { allow: method } });
}

function joinChunks(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  const joined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

/** The request body, or null when it is (or declares itself) larger than `maxBytes`. */
export async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  const declaredBytes = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) return null;
  if (!request.body) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) return joinChunks(chunks, totalBytes);
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
}
