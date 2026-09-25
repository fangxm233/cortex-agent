// input:  useHooksController, settings atoms, detail pane
// output: desktop hooks master-detail editor
// pos:    Hook list and editor composition
// >>> Once updated, update this header and parent AGENTS.md <<<

import '@/features/settings/ui/desktop-panels.css';
import { useEffect, useState, type CSSProperties } from 'react';
import type { HookDetail, HooksTestReturn } from '@cortex-agent/ui-contract';
import { useVocab, type Vocab } from '@/i18n';
import { SChip, SLinkAction, SPill } from '@/features/settings/ui/settings-ui';
import {
  CHIP_COUNT_STYLE,
  EDITOR_COLUMNS_STYLE,
  EDITOR_ROOT_STYLE,
  LIST_BODY_STYLE,
  LIST_EMPTY_STYLE,
  ListHeader,
  PaneFooter,
  listPaneStyle,
  listRowStyle,
} from '@/features/settings/ui/master-detail-ui';
import { HookDetailPane, MountBadge, type HookDetailPaneProps } from './HookDetailPane';
import {
  HOOK_FILTER_KEYS,
  buildHookCreateArgs,
  buildHookUpdateArgs,
  countHooksByFilter,
  emptyHookForm,
  filterHooks,
  formStateFromDetail,
  groupHooks,
  samplePayloadForEvent,
  type HookFilterKey,
  type HookFormState,
} from '@/features/settings/vm/hooks-panel-vm';
import { useHooksController } from '@/features/settings/controllers/useHooksController';

// Hooks panel (plan §5): master–detail inside the settings content pane, replacing the flat
// read-only card. The value this adds over `cortex-hook` is making "will this hook actually fire?"
// visible — mount targets, apply time, result legality, load order and a missing script are all
// surfaced on the surface itself rather than left in the debugging chapter of the docs.
//
// Capability is gated by `source`, never by hope: managed entries expose only the toggle (a later
// hook sync restores the shipped enabled state, so editing the rest would be a lie), and
// template-scoped entries are read-only because the writer rejects them outright.
//
// No optimistic updates: every mutation (in controllers/useHooksController) invalidates hooks.list
// and reports through a toast.

const MONO = "'IBM Plex Mono',monospace";
const LIST_WIDTH = 300;

const FILTER_LABEL: Record<HookFilterKey, keyof Vocab> = {
  all: 'hkFilterAll',
  agent: 'hkFilterAgent',
  claude: 'hkFilterClaude',
  pi: 'hkFilterPi',
  server: 'hkFilterServer',
  template: 'hkFilterTemplate',
};

// ── left column: chips, search, grouped list ──────────────────────────────────────────────────

const ORDER_STYLE: CSSProperties = {
  font: `500 12px ${MONO}`, color: 'var(--proto-muted-3)', flex: 'none', paddingTop: 2,
};

const EVENT_STYLE: CSSProperties = {
  font: `400 12px ${MONO}`, color: 'var(--proto-muted-2)', marginTop: 3, overflowWrap: 'anywhere',
};

function hookIdStyle(selected: boolean): CSSProperties {
  return {
    flex: 1, minWidth: 0, font: `600 12px ${MONO}`,
    color: selected ? 'var(--proto-accent)' : 'var(--proto-ink-2)',
    overflowWrap: 'anywhere',
  };
}

/** Where the hook mounts, and whether it is live — the two things a row is scanned for. */
function HookRowMeta({ hook }: { hook: HookDetail }) {
  const L = useVocab();
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 6 }}>
      {hook.mountsOn.map((target) => <MountBadge key={target} target={target} />)}
      <span style={{
        marginLeft: 'auto', fontSize: 12, fontWeight: 600, flex: 'none',
        color: hook.enabled ? 'var(--proto-success)' : 'var(--proto-muted-2)',
      }}>
        {hook.enabled ? L.stHookEnabled : L.stHookDisabled}
      </span>
    </div>
  );
}

function HookRow({ hook, selected, onSelect }: {
  hook: HookDetail;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const L = useVocab();
  return (
    <div
      data-hook-row={hook.id}
      data-hook-active={selected ? '' : undefined}
      onClick={() => onSelect(hook.id)}
      role="button"
      style={listRowStyle(selected, 'flex-start')}
    >
      <span data-hook-order={hook.order} style={ORDER_STYLE}>
        {String(hook.order).padStart(2, '0')}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={hookIdStyle(selected)}>{hook.id}</span>
          {hook.scriptExists === false ? (
            <SPill data-hook-broken="" title={L.hkScriptMissing} tone="danger">{L.hkBroken}</SPill>
          ) : null}
        </div>
        <div style={EVENT_STYLE}>{hook.event}</div>
        <HookRowMeta hook={hook} />
      </div>
    </div>
  );
}

function HookFilters({ counts, filter, onFilter }: {
  counts: Record<HookFilterKey, number>;
  filter: HookFilterKey;
  onFilter: (key: HookFilterKey) => void;
}) {
  const L = useVocab();
  return (
    <>
      {HOOK_FILTER_KEYS.map((key) => (
        <SChip
          key={key}
          data-hook-filter={key}
          data-active={key === filter ? '' : undefined}
          active={key === filter}
          onClick={() => onFilter(key)}
        >
          {L[FILTER_LABEL[key]]}
          <span style={CHIP_COUNT_STYLE}>{counts[key]}</span>
        </SChip>
      ))}
    </>
  );
}

function HookGroups({ visible, selectedId, onSelect }: {
  visible: HookDetail[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <>
      {groupHooks(visible).map((group) => (
        <div key={group.key} style={{ marginBottom: 6 }}>
          <div
            data-hook-group={group.key}
            style={{
              fontSize: 12, fontWeight: 600, letterSpacing: '.03em',
              color: 'var(--proto-muted-3)', padding: '8px 10px 4px',
            }}
          >
            {group.key === 'template' ? 'template' : `${group.key}:`}
          </div>
          {group.hooks.map((hook) => (
            <HookRow key={hook.id} hook={hook} selected={hook.id === selectedId} onSelect={onSelect} />
          ))}
        </div>
      ))}
    </>
  );
}

function HookList({
  hooks,
  visible,
  filter,
  search,
  selectedId,
  onFilter,
  onSearch,
  onSelect,
  onStartCreate,
}: {
  hooks: HookDetail[];
  visible: HookDetail[];
  filter: HookFilterKey;
  search: string;
  selectedId: string | null;
  onFilter: (key: HookFilterKey) => void;
  onSearch: (value: string) => void;
  onSelect: (id: string) => void;
  onStartCreate: () => void;
}) {
  const L = useVocab();
  const empty = hooks.length === 0 || visible.length === 0;
  return (
    <div className="settings-list-pane" style={listPaneStyle(LIST_WIDTH)}>
      <ListHeader
        title={L.stAgentHooks} count={hooks.length} searchAttr="data-hook-search"
        search={search} placeholder={L.hkSearchPh} onSearch={onSearch}
      >
        <HookFilters counts={countHooksByFilter(hooks, search)} filter={filter} onFilter={onFilter} />
      </ListHeader>
      <div style={LIST_BODY_STYLE}>
        {empty ? (
          <div data-hooks-empty="" style={LIST_EMPTY_STYLE}>
            {hooks.length === 0 ? L.stNoHooks : L.hkNoMatch}
          </div>
        ) : (
          <HookGroups visible={visible} selectedId={selectedId} onSelect={onSelect} />
        )}
      </div>
      <PaneFooter hint={L.hkOrderNote}>
        <SLinkAction data-action="create" onClick={onStartCreate}>+ {L.hkCreate}</SLinkAction>
      </PaneFooter>
    </div>
  );
}

// ── the pure view ─────────────────────────────────────────────────────────────────────────────

export interface HooksPanelViewProps extends HookDetailPaneProps {
  filter: HookFilterKey;
  search: string;
  selectedId: string | null;
  onFilter: (key: HookFilterKey) => void;
  onSearch: (value: string) => void;
  onSelect: (id: string) => void;
  onStartCreate: () => void;
}

export function HooksPanelView(props: HooksPanelViewProps) {
  const visible = filterHooks(props.hooks, props.filter, props.search);
  const hook = props.hooks.find((h) => h.id === props.selectedId) ?? null;
  return (
    <div data-settings-panel="hooks" style={EDITOR_ROOT_STYLE}>
      <div className="settings-editor-columns" data-hook-cards="" style={EDITOR_COLUMNS_STYLE}>
        <HookList
          hooks={props.hooks}
          visible={visible}
          filter={props.filter}
          search={props.search}
          selectedId={props.selectedId}
          onFilter={props.onFilter}
          onSearch={props.onSearch}
          onSelect={props.onSelect}
          onStartCreate={props.onStartCreate}
        />
        <HookDetailPane {...props} hook={hook} />
      </div>
    </div>
  );
}

// ── container: the editor state, over useHooksController ──────────────────────────────────────

export function HooksPanel() {
  const L = useVocab();

  const [creating, setCreating] = useState(false);
  const [createDraft, setCreateDraft] = useState<HookFormState>(emptyHookForm);
  /** Non-null only while the user has actually typed something — otherwise the record is the truth. */
  const [edits, setEdits] = useState<HookFormState | null>(null);
  const [armedDelete, setArmedDelete] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [testPayload, setTestPayload] = useState('');
  const [testResult, setTestResult] = useState<HooksTestReturn | null>(null);

  const hooksCtl = useHooksController({
    creating,
    onCreated: () => {
      setCreating(false);
      setCreateDraft(emptyHookForm());
    },
    onUpdated: () => setEdits(null),
    onRemoved: () => setArmedDelete(false),
    onTested: setTestResult,
  });
  const { hooks, selectedId, selected } = hooksCtl;

  // Selecting another hook drops the working copy and every transient affordance with it.
  useEffect(() => {
    setEdits(null);
    setArmedDelete(false);
    setTestOpen(false);
    setTestResult(null);
  }, [selectedId]);

  if (hooksCtl.isLoading) {
    return <div style={{ fontSize: 13, color: 'var(--proto-muted-2)' }}>{L.hkLoading}</div>;
  }
  if (hooksCtl.isError) {
    return (
      <div style={{ fontSize: 13, color: 'var(--proto-danger)', overflowWrap: 'anywhere' }}>
        {L.hkLoadFailed} {hooksCtl.errorMessage}
      </div>
    );
  }

  const draft = creating ? createDraft : edits ?? (selected ? formStateFromDetail(selected) : null);

  return (
    <HooksPanelView
      hooks={hooks}
      scripts={hooksCtl.scripts}
      hooksDir={hooksCtl.hooksDir}
      filter={hooksCtl.filter}
      search={hooksCtl.search}
      selectedId={selectedId}
      draft={draft}
      creating={creating}
      armedDelete={armedDelete}
      saving={hooksCtl.saving}
      testOpen={testOpen}
      testPayload={testPayload}
      testResult={testResult}
      testPending={hooksCtl.testPending}
      onFilter={hooksCtl.setFilter}
      onSearch={hooksCtl.setSearch}
      onSelect={(id) => {
        setCreating(false);
        hooksCtl.select(id);
      }}
      onStartCreate={() => {
        setCreating(true);
        setCreateDraft(emptyHookForm());
        setTestOpen(false);
        setArmedDelete(false);
      }}
      onCancelCreate={() => {
        setCreating(false);
        setCreateDraft(emptyHookForm());
      }}
      onDraftChange={(next) => (creating ? setCreateDraft(next) : setEdits(next))}
      onToggleEnabled={(target, next) => hooksCtl.setEnabled({ id: target.id, enabled: next })}
      onSave={() => {
        if (draft === null) return;
        if (creating) hooksCtl.create(buildHookCreateArgs(draft));
        else hooksCtl.update(buildHookUpdateArgs(draft));
      }}
      onRevert={() => setEdits(null)}
      onArmDelete={() => setArmedDelete(true)}
      onCancelDelete={() => setArmedDelete(false)}
      onConfirmDelete={() => {
        if (selected !== null) hooksCtl.remove({ id: selected.id });
      }}
      onOpenTest={() => {
        setTestOpen(true);
        setTestResult(null);
        if (selected !== null) setTestPayload(samplePayloadForEvent(selected.event));
      }}
      onCloseTest={() => {
        setTestOpen(false);
        setTestResult(null);
      }}
      onTestPayloadChange={setTestPayload}
      onRunTest={() => {
        if (selected !== null) hooksCtl.runTest({ id: selected.id, payload: testPayload });
      }}
    />
  );
}
