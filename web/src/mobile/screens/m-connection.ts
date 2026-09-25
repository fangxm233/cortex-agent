// Mobile presentation mapping for the live UI<->server connection status (shared by the 1e 项目
// header badge and the 1r Daemon screen pill). Pure — the status derivation itself lives in the
// shared `features/connection/connection-status`; this only maps it to the mobile palette's pill
// tone + pulse. Labels stay in each screen's inline COPY (mobile per-screen copy convention).
import type { ConnectionStatus } from '@/features/connection/connection-status';

/** MPill tone for a connection status: connected=done (green), (re)connecting=waiting (amber),
 *  disconnected=failed (red). */
export function mConnTone(status: ConnectionStatus): 'done' | 'waiting' | 'failed' {
  if (status === 'connected') return 'done';
  if (status === 'disconnected') return 'failed';
  return 'waiting'; // connecting | reconnecting
}

/** The dot pulses while the link is (re)connecting — signals live activity. */
export function mConnPulse(status: ConnectionStatus): boolean {
  return status === 'connecting' || status === 'reconnecting';
}
