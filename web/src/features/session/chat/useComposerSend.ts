import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { attachmentSendAllowed, uploadedAttachments, type AttachmentMeta } from '@/features/attachments/types';
import { useTRPC } from '@/lib/trpc';
import { useVocab } from '@/i18n';
import type { ContextCompactAction } from '@/features/session/composer/ContextUsageControl';
import {
  buildSlashSuggestions, resolveSlashInput, runSlashAction, slashFeedbackKey,
  type SlashAction, type SlashSuggestion,
} from '@/features/session/composer/composer-slash';
import type { ModelOption } from '@/features/session/list/selection-menu';
import type { DraftSelection } from '@/features/session/state/selected-session';
import { runOptimisticMutation } from '@/features/session/transcript/optimistic-message';
import type { OptimisticUserMessages } from '@/features/session/transcript/useOptimisticUserMessages';
import { useSlashSkills } from '@/features/session/composer/useSlashSkills';
import { useComposerDraft, type ComposerDraftScope, type ComposerDraftState } from './useComposerDraft';

export type SlashFeedbackKey = ReturnType<typeof slashFeedbackKey>;

/** What a draft's first message creates its session with, beyond the message itself. */
export interface DraftCreation {
  selection: DraftSelection;
}

export interface ComposerSlashHost {
  /** The models this conversation can move to — the same filtered list its picker shows. */
  modelOptions: ModelOption[];
  /** The backend this conversation runs on; it decides how a skill is invoked. */
  backend: string | null;
  /** The agent it runs in (null = the host's default), whose plugins decide its skills. */
  agentName: string | null;
  onNew: () => void;
  onModel: (option: ModelOption) => void;
  onSettings: () => void;
  onUsage: () => void;
}

export interface ComposerSendOptions extends ComposerDraftScope {
  optimistic: Pick<OptimisticUserMessages, 'prepare' | 'enqueue' | 'accept' | 'reject'>;
  creation: DraftCreation;
  running: boolean;
  compactAction?: ContextCompactAction;
  slash: ComposerSlashHost;
  /** The user is still on the draft its first message created a session from: follow it there. */
  onCreated: (sessionId: string) => void;
  /** A rejected send came back into the composer; say why. */
  onSendFailed: (error: Error) => void;
  /** A slash command was refused (key) or ran / was not a command (null). */
  onSlashFeedback: (key: SlashFeedbackKey) => void;
  /** The composer's text was consumed by a send or a command. */
  onConsumed?: () => void;
}

export interface ComposerSend extends ComposerDraftState {
  canSend: boolean;
  /** createAndSend in flight — the draft's project can no longer change under it. */
  creating: boolean;
  /** Run the typed text as a command if it is one, else send it. */
  submit: () => void;
  stop: () => void;
  stopPending: boolean;
  slashSuggestions: SlashSuggestion[];
  openCommands: () => void;
  /** A palette pick: run it, or put the command in for its argument (returns true then). A skill
   *  already typed in full is sent. */
  pickSlash: (suggestion: SlashSuggestion) => boolean;
}

type SendResult = { sessionId: string; acceptedAt: string } | { accepted: boolean; acceptedAt: string };

function useSendMutations() {
  const trpc = useTRPC();
  const sendMut = useMutation(trpc.sessions.send.mutationOptions());
  const createAndSendMut = useMutation(trpc.sessions.createAndSend.mutationOptions());
  const cancelMut = useMutation(trpc.sessions.cancel.mutationOptions());
  return { sendMut, createAndSendMut, cancelMut };
}

/**
 * The chat composer's controller, shared by the desktop and mobile composers: draft persistence and
 * uploads, local slash commands, stop, and the optimistic send — the row is on screen the frame the
 * composer clears, a draft's first message creates its session, and a rejected send comes back
 * into whichever scope it was written in.
 */
export function useComposerSend(options: ComposerSendOptions): ComposerSend {
  const trpc = useTRPC();
  const L = useVocab();
  const queryClient = useQueryClient();
  const { sendMut, createAndSendMut, cancelMut } = useSendMutations();
  const draft = useComposerDraft(options);
  const [browsingCommands, setBrowsingCommands] = useState(false);
  useEffect(() => { setBrowsingCommands(false); }, [draft.text, draft.identity]);
  const { sessionId, isDraft, running, compactAction } = options;

  const stop = (): void => {
    if (!sessionId || cancelMut.isPending) return;
    cancelMut.mutate({ sessionId });
  };
  const slashModels = options.slash.modelOptions.map((option) => ({
    name: option.provider ? `${option.provider}/${option.id}` : option.id, detail: option.selection.thinking ?? undefined, disabled: option.disabled,
  }));
  const slashSkills = useSlashSkills({
    sessionId, isDraft, agentName: options.slash.agentName, backend: options.slash.backend,
    enabled: browsingCommands || draft.text.trimStart().startsWith('/'),
  });
  const slashAvailability = {
    newDisabled: draft.uploads.hasNonDone,
    cancelDisabled: !running || cancelMut.isPending,
    compactDisabled: !compactAction || compactAction.disabled || compactAction.pending,
    settingsDisabled: draft.uploads.hasNonDone,
    usageDisabled: draft.uploads.hasNonDone,
  };
  const runSlash = (action: SlashAction): void => {
    draft.consumeText();
    options.onConsumed?.();
    runSlashAction(action, {
      onNew: options.slash.onNew,
      onCancel: () => { if (running) stop(); },
      onCompact: () => compactAction?.onCompact(),
      onModel: (name) => {
        const option = options.slash.modelOptions.find((o) => (o.provider ? `${o.provider}/${o.id}` : o.id) === name);
        if (option) options.slash.onModel(option);
      },
      onSettings: options.slash.onSettings,
      onUsage: options.slash.onUsage,
    });
  };
  const handleSlash = (value: string): boolean => {
    const resolution = resolveSlashInput(value, slashModels, slashAvailability, slashSkills);
    if (resolution.kind === 'none') return false;
    if (resolution.kind === 'action') runSlash(resolution.action);
    options.onSlashFeedback(slashFeedbackKey(resolution));
    return true;
  };

  const canSend = attachmentSendAllowed(draft.text, draft.uploads.items) && (!!sessionId || isDraft)
    && !sendMut.isPending && !createAndSendMut.isPending;

  const mutateSend = (text: string, attachments: AttachmentMeta[], draftUploadId?: string): Promise<SendResult> => {
    const withAttachments = attachments.length > 0 ? { attachments: uploadedAttachments(attachments) } : {};
    if (!isDraft) return sendMut.mutateAsync({ sessionId, text, ...withAttachments });
    const { selection } = options.creation;
    return createAndSendMut.mutateAsync({
      projectId: options.projectId,
      ...(selection.selection ? { selection: selection.selection } : {}),
      ...(selection.agentName ? { agentName: selection.agentName } : {}),
      text,
      draftUploadId,
      ...withAttachments,
    });
  };

  const onAccepted = (clientId: string, data: SendResult): void => {
    if (!('sessionId' in data)) {
      options.optimistic.accept(clientId, { acceptedAt: data.acceptedAt });
      return;
    }
    const follow = options.optimistic.accept(clientId, { acceptedAt: data.acceptedAt, createdSessionId: data.sessionId });
    queryClient.invalidateQueries(trpc.sessions.list.queryFilter());
    if (!follow) return;
    draft.releaseDraftBucket();
    options.onCreated(data.sessionId);
  };

  const sendText = (raw: string): void => {
    const text = raw.trim();
    const sent = draft.snapshot(text);
    if (!text && sent.attachments.length === 0) return;
    const sentKey = draft.draftKey;
    const sentIdentity = draft.identity;
    // The row is enqueued before the mutation is awaited, so the message is on screen on the same
    // frame the composer clears.
    const mutation = runOptimisticMutation<SendResult>({
      message: options.optimistic.prepare(text, sent.attachments),
      mutate: () => mutateSend(text, sent.attachments, sent.draftUploadId),
      onEnqueue: options.optimistic.enqueue,
      onAccepted: (entry, data) => onAccepted(entry.clientId, data),
      onRejected: (entry) => options.optimistic.reject(entry.clientId),
    });
    draft.consume();
    options.onConsumed?.();
    void mutation.then((result) => {
      if (result.ok || !result.restore) return;
      if (draft.restore(sent, sentKey, sentIdentity)) options.onSendFailed(result.error);
    });
  };

  const submit = (): void => {
    if (handleSlash(draft.text)) return;
    if (canSend) sendText(draft.text);
  };

  return {
    ...draft,
    canSend,
    creating: createAndSendMut.isPending,
    submit,
    stop,
    stopPending: cancelMut.isPending,
    openCommands: () => {
      if (!draft.text) draft.setText('/');
      else setBrowsingCommands(true);
    },
    slashSuggestions: buildSlashSuggestions(browsingCommands ? '/' : draft.text, slashModels, L, slashAvailability, slashSkills),
    pickSlash: (suggestion) => {
      if (suggestion.disabled) return false;
      setBrowsingCommands(false);
      if (suggestion.action) { runSlash(suggestion.action); return false; }
      if (suggestion.skill && draft.text.trim().toLowerCase() === suggestion.command.toLowerCase()) {
        submit();
        return false;
      }
      draft.setText(`${suggestion.command} `);
      return true;
    },
  };
}
