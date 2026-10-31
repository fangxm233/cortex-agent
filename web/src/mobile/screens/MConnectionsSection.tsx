import type { CSSProperties } from 'react';
import { useVocab } from '@/i18n';
import { MButton, MC, MDot, MONO } from '@/mobile/ui/kit';
import { MSET_INSET, MSettingsGroup, MSettingsGroupLabel as MGroupLabel } from './MSettingsControls';
import { CONNECTION_DELETE_RISK_VOCAB_KEYS, CONNECTION_KIND_VOCAB_KEYS, type ConnectionRowVm } from '@/features/settings/vm/connections-vm';

const META: CSSProperties = { fontSize: 12, color: MC.muted };
const CODE: CSSProperties = { font: `400 12px ${MONO}`, color: MC.muted, overflowWrap: 'anywhere' };

export interface MConnectionsProps {
  rows: ConnectionRowVm[];
  /** Row key armed for deletion by a first tap, or null. */
  confirmingDelete: string | null;
  savePending: boolean;
  removePending: boolean;
  onNew: () => void;
  onEdit: (row: ConnectionRowVm) => void;
  onDelete: (row: ConnectionRowVm) => void;
}

function RowHeading({ row }: { row: ConnectionRowVm }) {
  const L = useVocab();
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
      <MDot color={row.keyHint ? MC.done : MC.muted} />
      <span style={{ fontSize: 14, fontWeight: 650, color: MC.ink }}>{row.id}</span>
      <span style={META}>{L[CONNECTION_KIND_VOCAB_KEYS[row.kind]]}</span>
      {row.apiKeySlot ? <span data-conn-api-key-slot="" style={META}>{L.authLoginApiKey}</span> : null}
    </div>
  );
}

/** A connection carries no login: the row offers an editor and a two-tap delete. */
function ConnectionRow({ row, connections }: { row: ConnectionRowVm; connections: MConnectionsProps }) {
  const L = useVocab();
  const confirming = connections.confirmingDelete === row.key;
  return (
    <div data-connection={row.key} style={{ padding: `12px ${MSET_INSET}px`, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <RowHeading row={row} />
      <span style={CODE}>{row.meta}</span>
      {confirming ? <span data-conn-risk="" style={{ ...META, color: MC.fail }}>{L[CONNECTION_DELETE_RISK_VOCAB_KEYS[row.kind]]}</span> : null}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span data-conn-key-hint="" style={CODE}>{row.keyHint ?? L.connNoKey}</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <MButton compact data-conn-action="edit" data-conn-row={row.key}
            disabled={connections.savePending} onClick={() => connections.onEdit(row)}>{L.connEdit}</MButton>
          <MButton compact variant="danger-outline" data-conn-action="delete" data-conn-row={row.key}
            disabled={connections.removePending} onClick={() => connections.onDelete(row)}>
            {confirming ? L.connConfirmDelete : L.connDelete}
          </MButton>
        </span>
      </div>
    </div>
  );
}

export function MConnectionsSection({ connections }: { connections: MConnectionsProps }) {
  const L = useVocab();
  const add = (
    <MButton compact data-conn-action="new" disabled={connections.savePending} onClick={connections.onNew}>{L.connNew}</MButton>
  );
  return (
    <section>
      <MGroupLabel trailing={add}>{L.connTitle} · {connections.rows.length}</MGroupLabel>
      {connections.rows.length > 0
        ? <MSettingsGroup>{connections.rows.map((row) => <ConnectionRow key={row.key} row={row} connections={connections} />)}</MSettingsGroup>
        : <div style={{ ...META, padding: `4px ${MSET_INSET}px` }}>{L.connNone}</div>}
    </section>
  );
}
