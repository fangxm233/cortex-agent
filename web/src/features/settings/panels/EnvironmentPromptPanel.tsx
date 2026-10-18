import type { CSSProperties } from 'react';
import type { EnvironmentSystemPrompt } from '@cortex-agent/ui-contract';
import { useVocab } from '@/i18n';
import { useEnvironmentPromptController } from '@/features/settings/controllers/useEnvironmentPromptController';
import { SButton, SNotice, S_CONTROL_STYLE } from '@/features/settings/ui/settings-ui';
import { NoticeStack } from '@/features/settings/ui/master-detail-ui';
import {
  promptEditorState,
  promptSource,
  sharedNotice,
  type PromptEditorState,
} from '@/features/settings/vm/environment-prompt-vm';

const MONO = "'IBM Plex Mono',monospace";

const EDITOR_STYLE: CSSProperties = {
  ...S_CONTROL_STYLE,
  background: 'var(--proto-card)',
  fontFamily: MONO,
  minHeight: 320,
  resize: 'vertical',
  lineHeight: 1.65,
  // Prompts are prose: wrap rather than scroll sideways.
  whiteSpace: 'pre-wrap',
};

const MUTED: CSSProperties = { fontSize: 12, color: 'var(--proto-muted-2)', lineHeight: 1.6, overflowWrap: 'anywhere' };

export interface EnvironmentPromptViewProps {
  prompt: EnvironmentSystemPrompt;
  state: PromptEditorState;
  onText: (value: string) => void;
  onSave: () => void;
  onRevert: () => void;
  onRestore: () => void;
}

function PromptNotices({ prompt, locked }: { prompt: EnvironmentSystemPrompt; locked: boolean }) {
  const L = useVocab();
  const shared = sharedNotice(prompt, L);
  if (shared === null && !locked) return null;
  return (
    <NoticeStack>
      {shared !== null ? <SNotice tone="amber" data-prompt-shared="">{shared}</SNotice> : null}
      {locked ? <SNotice tone="amber" data-prompt-locked="">{L.ttPromptLocked}</SNotice> : null}
    </NoticeStack>
  );
}

function PromptActions(props: EnvironmentPromptViewProps) {
  const L = useVocab();
  const { state } = props;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
      <SButton tone="primary" disabled={!state.canSave} onClick={props.onSave} data-action="prompt-save">
        {L.ttSave}
      </SButton>
      <SButton tone="neutral" disabled={!state.canRevert} onClick={props.onRevert} data-action="prompt-revert">
        {L.ttRevert}
      </SButton>
      {props.prompt.defaultText !== null ? (
        <SButton tone="neutral" disabled={!state.canRestore} onClick={props.onRestore} data-action="prompt-restore">
          {L.ttPromptRestore}
        </SButton>
      ) : null}
      <span style={{ ...MUTED, flex: 1, minWidth: 160 }}>{L.ttPromptHint}</span>
    </div>
  );
}

export function EnvironmentPromptView(props: EnvironmentPromptViewProps) {
  const L = useVocab();
  return (
    <div data-environment-prompt={props.prompt.kind} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* A file source is a path (code face); "inline" / "none" are words (UI face). */}
      <span data-prompt-source="" style={{ ...MUTED, fontFamily: props.prompt.kind === 'file' && props.prompt.file ? MONO : undefined }}>
        {promptSource(props.prompt, L)}
      </span>
      <PromptNotices prompt={props.prompt} locked={props.state.locked} />
      <textarea
        data-environment-prompt-text=""
        value={props.state.text}
        spellCheck={false}
        placeholder={L.ttPromptEmptyPh}
        onChange={(e) => props.onText(e.target.value)}
        style={EDITOR_STYLE}
      />
      <PromptActions {...props} />
    </div>
  );
}

export interface EnvironmentPromptPanelProps {
  name: string;
  prompt: EnvironmentSystemPrompt;
  /** The working copy, held by the environments panel so a tab switch keeps it; null = untouched. */
  draft: string | null;
  bodyDirty: boolean;
  onDraft: (value: string | null) => void;
  onSaved?: () => void;
}

/** The System prompt tab: edits the text the environment's `systemPrompt` resolves to. */
export function EnvironmentPromptPanel(props: EnvironmentPromptPanelProps) {
  const { name, prompt, onDraft, onSaved } = props;
  const save = useEnvironmentPromptController(name, () => {
    onDraft(null);
    onSaved?.();
  });
  const state = promptEditorState({ prompt, draft: props.draft, bodyDirty: props.bodyDirty, pending: save.pending });
  return (
    <EnvironmentPromptView
      prompt={prompt}
      state={state}
      onText={onDraft}
      onSave={() => save.save(state.text)}
      onRevert={() => onDraft(null)}
      onRestore={() => onDraft(prompt.defaultText)}
    />
  );
}
