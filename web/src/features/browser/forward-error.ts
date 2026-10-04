import { fmt, type Vocab } from '@/i18n';
import { nativeErrorText } from '@/lib/native-error';
import { ForwardError } from './forward';

type ForwardVocab = Pick<Vocab, 'brForwardUnavailable' | 'brListPortsFailed' | 'brRequestFailed'
  | 'brForwardUnsupportedUrl' | 'brForwardNoLocalPort' | 'brForwardPrivilegedPort' | 'brForwardNoServer' | 'brForwardNoToken'>;

// Codes the shell's `forward_start` rejects with (desktop/src-tauri/src/forward.rs).
function nativeForwardCopy(L: ForwardVocab): Record<string, string> {
  return {
    forward_unsupported_server_url: L.brForwardUnsupportedUrl,
    forward_no_local_port: L.brForwardNoLocalPort,
    forward_privileged_port: L.brForwardPrivilegedPort,
    forward_no_server: L.brForwardNoServer,
    forward_no_token: L.brForwardNoToken,
  };
}

/** A forward/ports failure in the UI language; raw server detail passes through unchanged. */
export function forwardErrorText(error: unknown, L: ForwardVocab): string {
  if (!(error instanceof ForwardError)) return nativeErrorText(error, nativeForwardCopy(L));
  if (error.code === 'unavailable') return L.brForwardUnavailable;
  return fmt(error.code === 'list-ports' ? L.brListPortsFailed : L.brRequestFailed, { status: String(error.status) });
}
