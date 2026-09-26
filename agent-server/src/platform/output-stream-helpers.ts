import type { PlatformAdapter } from './adapter.js';
import type { Destination, MessageRef } from './types.js';
import type { OutputStream, OpenOutputStreamOpts } from './output-stream.js';

/** Post a single text message and return its parent MessageRef.
 *  Creates a transient OutputStream, emits, flushes, and disposes. */
export async function postOnce(
  adapter: PlatformAdapter,
  destination: Destination,
  text: string,
  opts?: OpenOutputStreamOpts,
): Promise<MessageRef | null> {
  const stream: OutputStream = adapter.openOutputStream(destination, opts);
  stream.emitText(text);
  await stream.flush();
  return stream.getParentRef();
}
