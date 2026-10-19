import '@/features/settings/ui/desktop-panels.css';
import { useEffect, useState, type CSSProperties } from 'react';
import type { HookDetail, HooksTestReturn } from '@cortex-agent/ui-contract';
import { useVocab, type Vocab } from '@/i18n';
import { SChip, SLinkAction, SStatus } from '@/features/settings/ui/settings-ui';
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
import { HookDetailPane, type HookDetailPaneProps } from './HookDetailPane';
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
  type HookNamespace,
  type HookFilterKey,
  type HookFormState,
} from '@/features/settings/vm/hooks-panel-vm';
import { useHooksController } from '@/features/settings/controllers/useHooksController';

// Hooks panel (plan §5): master–detail inside the settings content pane, replacing the flat
// read-only card. The value this adds over `cortex-hook` is making "will this hook actually fire?"
// visible — mount targets, apply time, result legality, load order and a missing script are all
// surfaced on the surface itself rather than left in the debugging chapter of the docs.
//
// Capability is gated by `source`, never by hope: built-in entries expose only the toggle (the
// rest follows the shipped entry).
//
// No optimistic updates: every mutation (in controllers/useHooksController) invalidates hooks.list
// and reports through a toast.

const MONO = "'IBM Plex Mono',monospace";
const LIST_WIDTH = 300;

const GROUP_LABEL: Record<HookNamespace, keyof Vocab> = {
  agent: 'hookGroupAgent', cc: 'hookGroupCc', pi: 'hookGroupPi', cortex: 'hookGroupCortex', other: 'hookGroupOther',
};

const FILTER_LABEL: Record<HookFilterKey, keyof Vocab> = {
  all: 'hkFilterAll',
  agent: 'hkFilterAgent',
  claude: 'hkFilterClaude',
  pi: 'hkFilterPi',
  server: 'hkFilterServer',
};

// ── left column: chips, search, grouped list ──────────────────────────────────────────────────

// The order is a number, so it is UI face with tabular figures; the hook id and its event are
// identifiers a person types into config, so they keep the code face.
const ORDER_STYLE: CSSProperties = {
  fontSize: 12, fontWeight: 500, fontVariantNumeric: 'tabular-nums', color: 'var(--proto-muted-3)', flex: 'none', paddingTop: 2,
};

const META_STYLE: CSSProperties = {
  fontSize: 12, color: 'var(--proto-muted-2)', marginTop: 2, overflowWrap: 'anywhere',
};

function hookIdStyle(selected: boolean): CSSProperties {
  return {
    flex: 1, minWidth: 0, font: `600 12px ${MONO}`,
    color: selected ? 'var(--proto-ink)' : 'var(--proto-ink-2)',
    overflowWrap: 'anywhere',
  };
}

/** The event, where it mounts, and — only when it is off — that it is off. */
function HookRowMeta({ hook }: { hook: HookDetail }) {
  const L = useVocab();
  const extra = [...hook.mountsOn, ...(hook.enabled ? [] : [L.stHookDisabled])];
  return (
    <div data-hook-meta="" style={META_STYLE}>
      <span style={{ fontFamily: MONO }}>{hook.event}</span>
      {extra.length > 0 ? ` · ${extra.join(' · ')}` : null}
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
      data-hook-enabled={hook.enabled ? '' : undefined}
      onClick={() => onSelect(hook.id)}
      role="button"
      style={{ ...listRowStyle(selected, 'flex-start'), opacity: hook.enabled ? 1 : 0.6 }}
    >
      <span data-hook-order={hook.order} style={ORDER_STYLE}>
        {String(hook.order).padStart(2, '0')}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={hookIdStyle(selected)}>{hook.id}</span>
          {hook.scriptExists === false ? (
            <SStatus data-hook-broken="" title={L.hkScriptMissing} tone="danger">{L.hkBroken}</SStatus>
          ) : null}
        </div>
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
  const L = useVocab();
  return (
    <>
      {groupHooks(visible).map((group) => (
        <div key={group.key} style={{ marginBottom: 6 }}>
          <div
            data-hook-group={group.key}
            style={{
              fontSize: 12, fontWeight: 600, fontVariantNumeric: 'tabular-nums',
              color: 'var(--proto-muted-2)', padding: '8px 10px 4px',
            }}
          >
            {`${L[GROUP_LABEL[group.key]]} · ${group.hooks.length}`}
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
