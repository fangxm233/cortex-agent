import { useEffect, useState, type CSSProperties } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { PluginsSkillFile, UiPluginCatalogEntry, UiPluginSkill } from '@cortex-agent/ui-contract';
import { Modal, Select } from '@/design';
import { useVocab, type Vocab } from '@/i18n';
import { useTRPC } from '@/lib/trpc';
import { SButton, SFieldRow, SNotice, SPill, S_CONTROL_STYLE } from '@/features/settings/ui/settings-ui';
import { EmptyMessage, ROW } from '@/features/settings/ui/plugin-ui';
import { isCanonicalName } from '@/features/settings/vm/plugin-authoring-vm';
import type { PluginAuthoringActions } from '@/features/settings/controllers/usePluginAuthoring';

const MONO = "'IBM Plex Mono',monospace";
const EDITOR: CSSProperties = {
  ...S_CONTROL_STYLE, background: 'var(--proto-card)',
  fontFamily: MONO, minHeight: 240, resize: 'vertical', lineHeight: 1.55, whiteSpace: 'pre', overflowX: 'auto',
};
const ACTIONS: CSSProperties = { display: 'flex', gap: 8, marginLeft: 'auto', flexWrap: 'wrap' };
const PATH_LINE: CSSProperties = { font: `400 12px ${MONO}`, color: 'var(--proto-muted-3)', overflowWrap: 'anywhere', minWidth: 0 };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type SkillOrigin = UiPluginSkill['origin'];

function originNote(origin: PluginsSkillFile['origin'], L: Vocab): string | null {
  if (origin === 'builtin') return L.plBuiltinSkillNote;
  return origin === 'overridden' ? L.plModifiedSkillNote : null;
}

/** Built-in skills (edited or not) stay where Cortex ships them. */
function isBuiltinSkill(origin: SkillOrigin): boolean {
  return origin === 'builtin' || origin === 'overridden';
}

function OriginPill(props: { origin: SkillOrigin }) {
  const L = useVocab();
  if (props.origin === 'local') return null;
  const modified = props.origin === 'overridden';
  return (
    <SPill tone={modified ? 'amber' : 'strong'} data-plugin-skill-origin={props.origin}>
      {modified ? L.plOriginModified : L.plOriginBuiltin}
    </SPill>
  );
}

/** The open editor, keyed by skill so switching rows always reloads from disk. */
function SkillEditor(props: {
  pluginId: string;
  skill: string;
  busy: boolean;
  onSave: (content: string, baseHash: string) => Promise<string | null>;
}) {
  const L = useVocab();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const query = useQuery(trpc.plugins.skillFile.queryOptions({ pluginId: props.pluginId, skill: props.skill }));
  // `saved` is what this editor believes is on disk. It advances on a successful write rather than
  // waiting for the refetch, so the Save button settles immediately instead of staying lit.
  const [state, setState] = useState<{ draft: string; saved: string; baseHash: string } | null>(null);

  useEffect(() => {
    const data = query.data;
    if (!data) return;
    setState((current) => current ?? { draft: data.content, saved: data.content, baseHash: data.baseHash });
  }, [query.data]);

  if (query.isLoading) return <EmptyMessage text={L.plSkillLoading} dataAttr="data-plugin-skill-loading" />;
  if (query.isError) {
    return <EmptyMessage text={`${L.plSkillLoadFailed} ${errorMessage(query.error)}`} dataAttr="data-plugin-skill-error" />;
  }
  const file = query.data;
  if (!file || !state) return null;
  const dirty = state.draft !== state.saved;
  const note = originNote(file.origin, L);

  return (
    <div data-plugin-skill-editor={props.skill} style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
      {note ? <SNotice tone="muted" data-plugin-skill-note={file.origin}>{note}</SNotice> : null}
      <div style={PATH_LINE}>{file.path}</div>
      <textarea data-plugin-skill-source={props.skill} value={state.draft} spellCheck={false}
        onChange={(event) => setState({ ...state, draft: event.target.value })} style={EDITOR} />
      <div style={{ display: 'flex', gap: 8 }}>
        <SButton tone="primary" data-action="skill-save" disabled={props.busy || !dirty}
          onClick={async () => {
            const next = await props.onSave(state.draft, state.baseHash);
            if (!next) return;
            setState({ draft: state.draft, saved: state.draft, baseHash: next });
            await queryClient.invalidateQueries(
              trpc.plugins.skillFile.queryFilter({ pluginId: props.pluginId, skill: props.skill }),
            );
          }}>
          {props.busy ? L.plSkillSaving : L.plSkillSave}
        </SButton>
      </div>
    </div>
  );
}

function SkillRow(props: {
  plugin: UiPluginCatalogEntry;
  skill: UiPluginSkill;
  open: boolean;
  busy: boolean;
  actions: PluginAuthoringActions;
  onToggle: () => void;
  onMove: () => void;
  onDelete: () => void;
  onRevert: () => void;
}) {
  const L = useVocab();
  const locked = isBuiltinSkill(props.skill.origin);
  const lockedTitle = locked ? L.plBuiltinSkillLocked : undefined;
  return (
    <div data-plugin-skill={props.skill.name} style={ROW}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--proto-ink)', minWidth: 0, overflowWrap: 'anywhere' }}>{props.skill.name}</span>
        <OriginPill origin={props.skill.origin} />
        <div style={ACTIONS}>
          <SButton tone="neutral" data-action="skill-open" onClick={props.onToggle}>
            {props.open ? L.plSkillClose : L.plSkillOpen}
          </SButton>
          {props.skill.origin === 'overridden' ? (
            <SButton tone="neutral" data-action="skill-revert" disabled={props.busy} onClick={props.onRevert}>
              {L.plSkillRevert}
            </SButton>
          ) : null}
          <SButton tone="neutral" data-action="skill-move" disabled={props.busy || locked} title={lockedTitle} onClick={props.onMove}>
            {L.plSkillRename}
          </SButton>
          <SButton tone="danger" data-action="skill-delete" disabled={props.busy || locked} title={lockedTitle} onClick={props.onDelete}>
            {L.plSkillDelete}
          </SButton>
        </div>
      </div>
      {props.skill.description
        ? <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--proto-muted-2)', marginTop: 2 }}>{props.skill.description}</div>
        : null}
      <div style={{ ...PATH_LINE, marginTop: 6 }}>
        {`${props.plugin.rootDir}/skills/${props.skill.name}/SKILL.md`}
      </div>
      {props.open ? (
        <SkillEditor pluginId={props.plugin.id} skill={props.skill.name} busy={props.busy}
          onSave={async (content, baseHash) => {
            const result = await props.actions.skillWrite({
              pluginId: props.plugin.id, skill: props.skill.name, content, baseHash,
            });
            return result?.baseHash ?? null;
          }} />
      ) : null}
    </div>
  );
}

function CreateSkillForm(props: { pluginId: string; busy: boolean; actions: PluginAuthoringActions }) {
  const L = useVocab();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const nameBad = name.length > 0 && !isCanonicalName(name);
  const ready = isCanonicalName(name) && description.trim().length > 0;
  return (
    <div data-plugin-skill-create="" style={{ ...ROW, gap: 8 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--proto-ink)' }}>{L.plSkillNewTitle}</div>
      <SFieldRow label={L.plSkillNewName} hint={nameBad ? L.plNameInvalid : undefined} hintTone="danger">
        <input data-field="skill-name" value={name} placeholder={L.plSkillNewNamePh}
          onChange={(event) => setName(event.target.value)} style={S_CONTROL_STYLE} />
      </SFieldRow>
      <SFieldRow label={L.plSkillNewDesc} hint={L.plDescRequired}>
        <input data-field="skill-description" value={description} placeholder={L.plSkillNewDescPh}
          onChange={(event) => setDescription(event.target.value)} style={S_CONTROL_STYLE} />
      </SFieldRow>
      <div style={{ display: 'flex' }}>
        <SButton tone="primary" data-action="skill-create" disabled={props.busy || !ready}
          onClick={async () => {
            const done = await props.actions.skillCreate({
              pluginId: props.pluginId, skill: name, description: description.trim(),
            });
            if (done) { setName(''); setDescription(''); }
          }}>
          {L.plSkillCreate}
        </SButton>
      </div>
    </div>
  );
}

function MoveSkillModal(props: {
  plugin: UiPluginCatalogEntry;
  plugins: readonly UiPluginCatalogEntry[];
  skill: string;
  busy: boolean;
  actions: PluginAuthoringActions;
  onClose: () => void;
}) {
  const L = useVocab();
  const [toPluginId, setToPluginId] = useState(props.plugin.id);
  const [toSkill, setToSkill] = useState(props.skill);
  const nameBad = toSkill.length > 0 && !isCanonicalName(toSkill);
  const unchanged = toPluginId === props.plugin.id && toSkill === props.skill;
  return (
    <Modal open layer="nested" contentClassName="settings-surface settings-nested-modal"
      contentDataAttributes={{ 'data-settings-dialog': '' }} title={L.plSkillRenameTitle} onOpenChange={(next) => { if (!next) props.onClose(); }}
      footer={(
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' }}>
          <SButton tone="neutral" onClick={props.onClose}>{L.plCancel}</SButton>
          <SButton tone="primary" data-action="skill-move-confirm"
            disabled={props.busy || unchanged || !isCanonicalName(toSkill)}
            onClick={async () => {
              const done = await props.actions.skillMove({
                pluginId: props.plugin.id, skill: props.skill, toPluginId, toSkill,
              });
              if (done) props.onClose();
            }}>
            {L.plSkillMove}
          </SButton>
        </div>
      )}>
      <SFieldRow label={L.plSkillRenamePlugin}>
        <Select popupClassName="settings-surface settings-select-popup" value={toPluginId} onValueChange={setToPluginId} style={S_CONTROL_STYLE}
          options={props.plugins.map((plugin) => ({ value: plugin.id, label: plugin.id }))} />
      </SFieldRow>
      <SFieldRow label={L.plSkillRenameName} hint={nameBad ? L.plNameInvalid : undefined} hintTone="danger">
        <input data-field="skill-move-name" value={toSkill}
          onChange={(event) => setToSkill(event.target.value)} style={S_CONTROL_STYLE} />
      </SFieldRow>
    </Modal>
  );
}

function DeleteSkillModal(props: {
  pluginId: string;
  skill: string;
  busy: boolean;
  actions: PluginAuthoringActions;
  onClose: () => void;
}) {
  const L = useVocab();
  return (
    <Modal open layer="nested" contentClassName="settings-surface settings-nested-modal"
      contentDataAttributes={{ 'data-settings-dialog': '' }} title={L.plSkillDeleteTitle.replace('{name}', props.skill)}
      onOpenChange={(next) => { if (!next) props.onClose(); }}
      footer={(
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' }}>
          <SButton tone="neutral" onClick={props.onClose}>{L.plCancel}</SButton>
          <SButton tone="danger" data-action="skill-delete-confirm" disabled={props.busy}
            onClick={async () => {
              await props.actions.skillRemove({ pluginId: props.pluginId, skill: props.skill });
              props.onClose();
            }}>
            {L.plConfirmDelete}
          </SButton>
        </div>
      )}>
      <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--proto-muted-2)' }}>{L.plSkillDeleteDesc}</div>
    </Modal>
  );
}

function RevertSkillModal(props: {
  pluginId: string;
  skill: string;
  busy: boolean;
  actions: PluginAuthoringActions;
  onClose: () => void;
}) {
  const L = useVocab();
  return (
    <Modal open layer="nested" contentClassName="settings-surface settings-nested-modal"
      contentDataAttributes={{ 'data-settings-dialog': '' }} title={L.plSkillRevertTitle.replace('{name}', props.skill)}
      onOpenChange={(next) => { if (!next) props.onClose(); }}
      footer={(
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' }}>
          <SButton tone="neutral" onClick={props.onClose}>{L.plCancel}</SButton>
          <SButton tone="danger" data-action="skill-revert-confirm" disabled={props.busy}
            onClick={async () => {
              await props.actions.skillRevert({ pluginId: props.pluginId, skill: props.skill });
              props.onClose();
            }}>
            {L.plConfirmRevert}
          </SButton>
        </div>
      )}>
      <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--proto-muted-2)' }}>{L.plSkillRevertDesc}</div>
    </Modal>
  );
}

function builtinNote(plugin: UiPluginCatalogEntry, L: Vocab): string | null {
  return plugin.origin === 'builtin' ? L.plBuiltinPluginNote : null;
}

export function PluginSkillsTab(props: {
  plugin: UiPluginCatalogEntry;
  plugins: readonly UiPluginCatalogEntry[];
  actions: PluginAuthoringActions;
}) {
  const L = useVocab();
  const [open, setOpen] = useState<string | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [reverting, setReverting] = useState<string | null>(null);
  const note = builtinNote(props.plugin, L);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {note ? <SNotice tone="muted" data-plugin-builtin-note="">{note}</SNotice> : null}
      {props.plugin.skills.length === 0
        ? <EmptyMessage text={L.plNoSkills} dataAttr="data-plugin-skills-empty" />
        : props.plugin.skills.map((skill) => (
          <SkillRow key={skill.name} plugin={props.plugin} skill={skill} busy={props.actions.busy}
            actions={props.actions} open={open === skill.name}
            onToggle={() => setOpen((current) => (current === skill.name ? null : skill.name))}
            onMove={() => setMoving(skill.name)}
            onDelete={() => setDeleting(skill.name)}
            onRevert={() => setReverting(skill.name)} />
        ))}
      <CreateSkillForm pluginId={props.plugin.id} busy={props.actions.busy} actions={props.actions} />
      {moving ? (
        <MoveSkillModal plugin={props.plugin} plugins={props.plugins} skill={moving}
          busy={props.actions.busy} actions={props.actions} onClose={() => setMoving(null)} />
      ) : null}
      {deleting ? (
        <DeleteSkillModal pluginId={props.plugin.id} skill={deleting}
          busy={props.actions.busy} actions={props.actions} onClose={() => setDeleting(null)} />
      ) : null}
      {reverting ? (
        // The open editor holds the text being reverted; closing it makes the next open read afresh.
        <RevertSkillModal pluginId={props.plugin.id} skill={reverting}
          busy={props.actions.busy} actions={props.actions}
          onClose={() => { setOpen((current) => (current === reverting ? null : current)); setReverting(null); }} />
      ) : null}
    </div>
  );
}
