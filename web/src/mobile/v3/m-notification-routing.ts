// input:  untrusted notification targets and server lookup results
// output: validated encoded mobile destinations and project scope
// pos:    Notification target validation and route projection
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<

export interface NotificationRoute { path: string; projectId?: string }
interface SessionTarget { sessionId: string; projectId: string | null }
interface ApprovalTarget { id: string; projectId: string | null }
export interface NotificationLookups {
  sessions: () => Promise<SessionTarget[]>;
  approvals: () => Promise<ApprovalTarget[]>;
}

export function notificationTargetId(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) return undefined;
  if (/[\u0000-\u001f\u007f]/.test(value)) return undefined;
  // Reject lone surrogates before encodeURIComponent can throw.
  try { encodeURIComponent(value); return value; } catch { return undefined; }
}

async function sessionRoute(data: Record<string, unknown>, lookup: NotificationLookups): Promise<NotificationRoute> {
  const id = notificationTargetId(data.sessionId);
  if (!id) return { path: '/m/sessions' };
  const session = (await lookup.sessions()).find((entry) => entry.sessionId === id);
  if (!session) return { path: '/m/sessions' };
  return { path: `/m/session/${encodeURIComponent(id)}`, projectId: session.projectId ?? undefined };
}

async function approvalRoute(data: Record<string, unknown>, lookup: NotificationLookups): Promise<NotificationRoute> {
  const id = notificationTargetId(data.approvalId);
  if (!id) return { path: '/m/approvals' };
  const approval = (await lookup.approvals()).find((entry) => entry.id === id);
  if (!approval) return { path: '/m/approvals' };
  return { path: `/m/approvals?approvalId=${encodeURIComponent(id)}`, projectId: approval.projectId ?? undefined };
}

export async function resolveNotificationRoute(
  data: Record<string, unknown>, lookup: NotificationLookups,
): Promise<NotificationRoute> {
  const kind = data.kind ?? (data.sessionId ? 'session' : 'sessions');
  if (kind === 'session') return sessionRoute(data, lookup);
  if (kind === 'approvals') return approvalRoute(data, lookup);
  return { path: '/m/sessions' };
}
