// input:  one plugin's skills, the SKILL.md query, and the authoring actions
// output: the skills tab — list, inline SKILL.md editor, create, move and delete
// pos:    Skill management inside the plugin package manager
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { useEffect, useState, type CSSProperties } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { PluginsSkillFile, UiPluginCatalogEntry, UiPluginSkill } from '@cortex-agent/ui-contract';
import { Modal, Select } from '@/design';
import { useVocab, type Vocab } from '@/i18n';
import { useTRPC } from '@/lib/trpc';
import { SButton, SFieldRow, S_CONTROL_STYLE } from './settings-ui';
import { EmptyMessage, NOTICE, PILL, ROW } from './plugin-ui';
import { isCanonicalName } from './plugin-authoring-vm';
import type { PluginAuthoringActions } from './usePluginAuthoring';

const MONO = "'IBM Plex Mono',monospace";
const EDITOR: CSSProperties = {
  ...S_CONTROL_STYLE, minHeight: 240, resize: 'vertical', lineHeight: 1.55, whiteSpace: 'pre',
};
const ACTIONS: CSSProperties = { display: 'flex', gap: 6, marginLeft: 'auto', flexWrap: 'wrap' };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  const query = useQuery<PluginsSkillFile>(
    trpc.plugins.skillFile.queryOptions({ pluginId: props.pluginId, skill: props.skill }) as never,
  );
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

  return (
    <div data-plugin-skill-editor={props.skill} style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
      {file.managed ? <div data-plugin-skill-managed="" style={NOTICE}>{L.plManagedSkillNote}</div> : null}
      <div style={{ font: `400 9.5px ${MONO}`, color: 'var(--proto-faint)' }}>{file.path}</div>
      <textarea data-plugin-skill-source={props.skill} value={state.draft} spellCheck={false}
        onChange={(event) => setState({ ...state, draft: event.target.value })} style={EDITOR} />
      <div style={{ display: 'flex', gap: 6 }}>
        <SButton tone="accent" data-action="skill-save" disabled={props.busy || !dirty}
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
}) {
  const L = useVocab();
  return (
    <div data-plugin-skill={props.skill.name} style={ROW}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ font: `600 11.5px ${MONO}`, color: 'var(--proto-ink)' }}>{props.skill.name}</span>
        {props.skill.managed ? <span style={PILL}>{L.plOriginManaged}</span> : null}
        <div style={ACTIONS}>
          <SButton tone="neutral" data-action="skill-open" onClick={props.onToggle}>
            {props.open ? L.plSkillClose : L.plSkillOpen}
          </SButton>
          <SButton tone="neutral" data-action="skill-move" disabled={props.busy} onClick={props.onMove}>
            {L.plSkillRename}
          </SButton>
          <SButton tone="danger" data-action="skill-delete" disabled={props.busy} onClick={props.onDelete}>
            {L.plSkillDelete}
          </SButton>
        </div>
      </div>
      {props.skill.description
        ? <div style={{ fontSize: 10.5, color: 'var(--proto-muted-2)', marginTop: 4 }}>{props.skill.description}</div>
        : null}
      <div style={{ font: `400 9.5px ${MONO}`, color: 'var(--proto-faint)', marginTop: 3 }}>
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
    <div data-plugin-skill-create="" style={{ ...ROW, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontSize: 11.5, fontWeight: 650, color: 'var(--proto-ink)' }}>{L.plSkillNewTitle}</div>
      <SFieldRow label={L.plSkillNewName} hint={nameBad ? L.plNameInvalid : undefined} hintTone="danger">
        <input data-field="skill-name" value={name} placeholder={L.plSkillNewNamePh}
          onChange={(event) => setName(event.target.value)} style={S_CONTROL_STYLE} />
      </SFieldRow>
      <SFieldRow label={L.plSkillNewDesc} hint={L.plDescRequired}>
        <input data-field="skill-description" value={description} placeholder={L.plSkillNewDescPh}
          onChange={(event) => setDescription(event.target.value)} style={S_CONTROL_STYLE} />
      </SFieldRow>
      <div style={{ display: 'flex' }}>
        <SButton tone="accent" data-action="skill-create" disabled={props.busy || !ready}
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
    <Modal open layer="nested" title={L.plSkillRenameTitle} onOpenChange={(next) => { if (!next) props.onClose(); }}
      footer={(
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <SButton tone="neutral" onClick={props.onClose}>{L.plCancel}</SButton>
          <SButton tone="accent" data-action="skill-move-confirm"
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
        <Select value={toPluginId} onValueChange={setToPluginId}
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
    <Modal open layer="nested" title={L.plSkillDeleteTitle.replace('{name}', props.skill)}
      onOpenChange={(next) => { if (!next) props.onClose(); }}
      footer={(
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
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
      <div style={{ fontSize: 11, color: 'var(--proto-muted-2)' }}>{L.plSkillDeleteDesc}</div>
    </Modal>
  );
}

function managedNote(plugin: UiPluginCatalogEntry, L: Vocab): string | null {
  return plugin.origin === 'managed' ? L.plManagedPluginNote : null;
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
  const note = managedNote(props.plugin, L);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {note ? <div data-plugin-managed-note="" style={NOTICE}>{note}</div> : null}
      {props.plugin.skills.length === 0
        ? <EmptyMessage text={L.plNoSkills} dataAttr="data-plugin-skills-empty" />
        : props.plugin.skills.map((skill) => (
          <SkillRow key={skill.name} plugin={props.plugin} skill={skill} busy={props.actions.busy}
            actions={props.actions} open={open === skill.name}
            onToggle={() => setOpen((current) => (current === skill.name ? null : skill.name))}
            onMove={() => setMoving(skill.name)}
            onDelete={() => setDeleting(skill.name)} />
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
    </div>
  );
}
