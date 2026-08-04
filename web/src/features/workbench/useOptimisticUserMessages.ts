// input:  the surface's send scope plus the live message authority it renders
// output: reconciled pending rows and the enqueue/accept/reject send lifecycle
// pos:    Shared optimistic-send state for the desktop and mobile chats
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionTranscript } from '@cortex-agent/ui-contract';
import {
  acceptOptimisticUserMessage,
  createOptimisticUserMessage,
  promoteOptimisticUserMessage,
  reconcileOptimisticUserMessages,
  resolveOptimisticRejection,
  shouldSelectCreatedSession,
  type OptimisticUserMessage,
  type UserMessageAuthority,
} from './optimistic-message';
import type { Attachment, LiveSessionMessage, PendingUserMessage } from './transcript-vm';

export interface OptimisticUserMessagesInput {
  /** The open session, or '' while the surface is a new-session draft. */
  sessionId: string;
  isDraft: boolean;
  /** Project the draft belongs to — scopes a draft send until its session exists. */
  projectId: string;
  transcript: SessionTranscript | null;
  liveTail: LiveSessionMessage[];
  /** Server-side pending rows (accepted into a running turn, not yet read by the model). */
  pendingUser: PendingUserMessage[];
  /** Reads the newest authority before queued React state renders (send-during-send races). */
  getMessageSnapshot: () => { liveTail: LiveSessionMessage[]; pendingUser: PendingUserMessage[] };
}

export interface OptimisticUserMessages {
  /** Server-pending plus still-unmatched local rows — what the surface renders. */
  pendingUser: PendingUserMessage[];
  /** Builds the local row for a send, baselined against the authority at this instant. */
  prepare: (text: string, attachments?: Attachment[]) => OptimisticUserMessage;
  /** Shows the row. Call before awaiting the mutation. */
  enqueue: (message: OptimisticUserMessage) => void;
  /** Settles a send. With a created session id the draft row is re-targeted at it; the return
   *  value then says whether this surface should follow the send into that session. */
  accept: (clientId: string, createdSessionId?: string) => boolean;
  /** Drops the row and reports whether the composer should take its content back — false when the
   *  server actually accepted the message and only the response was lost. */
  reject: (clientId: string) => boolean;
}

/**
 * A sent message appears in the transcript on the same frame it is sent, instead of after the
 * server round-trip. The row is local until the authority (transcript, live tail, or server-pending
 * list) carries a matching message; reconciliation then hands the row over with no flicker and no
 * doubling, and only a durable match retires it from state.
 */
export function useOptimisticUserMessages(input: OptimisticUserMessagesInput): OptimisticUserMessages {
  const { sessionId, isDraft, projectId, transcript, liveTail, pendingUser, getMessageSnapshot } = input;
  const [messages, setMessages] = useState<OptimisticUserMessage[]>([]);
  const messagesRef = useRef<OptimisticUserMessage[]>([]);
  const projectRef = useRef(projectId);
  const draftActiveRef = useRef(isDraft);
  projectRef.current = projectId;
  draftActiveRef.current = isDraft;

  const authority = useMemo<UserMessageAuthority>(() => ({
    transcript: transcript ?? { sessionId, turns: [], pendingUserMessages: [] },
    liveTail,
    pendingUser,
  }), [transcript, sessionId, liveTail, pendingUser]);
  const authorityRef = useRef<UserMessageAuthority>(authority);
  authorityRef.current = authority;
  const currentAuthority = useCallback((): UserMessageAuthority => ({
    ...authorityRef.current,
    ...getMessageSnapshot(),
  }), [getMessageSnapshot]);

  const update = useCallback((next: (current: OptimisticUserMessage[]) => OptimisticUserMessage[]) => {
    setMessages((current) => {
      const updated = next(current);
      messagesRef.current = updated;
      return updated;
    });
  }, []);

  const scoped = useMemo(() => messages.filter((message) => isDraft
    ? message.target.kind === 'draft' && message.target.projectId === projectId
    : message.target.kind === 'session' && message.target.sessionId === sessionId),
  [messages, isDraft, projectId, sessionId]);
  const reconciled = useMemo(() => reconcileOptimisticUserMessages(scoped, authority), [scoped, authority]);
  useEffect(() => {
    if (reconciled.settledClientIds.length === 0) return;
    const settled = new Set(reconciled.settledClientIds);
    update((current) => current.filter((message) => !settled.has(message.clientId)));
  }, [reconciled.settledClientIds, update]);

  const prepare = useCallback((text: string, attachments?: Attachment[]) => {
    const target = isDraft
      ? { kind: 'draft' as const, projectId }
      : { kind: 'session' as const, sessionId };
    return createOptimisticUserMessage({
      clientId: crypto.randomUUID(), target, text, attachments, ts: new Date().toISOString(),
    }, messagesRef.current, currentAuthority());
  }, [isDraft, projectId, sessionId, currentAuthority]);

  const enqueue = useCallback((message: OptimisticUserMessage) => {
    update((current) => [...current, message]);
  }, [update]);

  const accept = useCallback((clientId: string, createdSessionId?: string) => {
    const message = messagesRef.current.find((item) => item.clientId === clientId);
    const selectCreated = !!createdSessionId && !!message
      && shouldSelectCreatedSession(message, projectRef.current, draftActiveRef.current);
    update((current) => createdSessionId
      ? promoteOptimisticUserMessage(current, clientId, createdSessionId)
      : acceptOptimisticUserMessage(current, clientId));
    return createdSessionId ? selectCreated : true;
  }, [update]);

  const reject = useCallback((clientId: string) => {
    const resolution = resolveOptimisticRejection(messagesRef.current, clientId, currentAuthority());
    update(() => resolution.messages);
    return resolution.restore;
  }, [currentAuthority, update]);

  return { pendingUser: reconciled.pendingUser, prepare, enqueue, accept, reject };
}
