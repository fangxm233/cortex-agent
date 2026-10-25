import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { confirmDialog, useToast } from '@/design';
import { fmt, useLang, useVocab } from '@/i18n';
import { copyText } from '@/lib/clipboard';
import { apiBase } from '@/lib/desktop-config';
import { useNowTick } from '@/lib/useNowTick';
import {
  createPairingCode, fetchPairedDevices, revokePairedDevice, type MintedPairingCode,
} from './devices-api';
import { activeCodeView, pairedAppRows, pairingAddress, type ActiveCodeView, type PairedAppRow } from './paired-apps-vm';

const QUERY_KEY = ['ui-paired-devices'];

export interface PairedAppsController {
  /** False while loading, on failure, or against a server without pairing. */
  visible: boolean;
  /** Codes can be minted here. */
  pairing: boolean;
  rows: PairedAppRow[];
  code: ActiveCodeView | null;
  creating: boolean;
  createCode: () => void;
  copyCode: () => void;
  copyLink: () => void;
  revoke: (row: PairedAppRow) => void;
}

function useCopy() {
  const L = useVocab();
  const { toast } = useToast();
  return async (text: string | null | undefined) => {
    if (!text) return;
    const ok = await copyText(text);
    toast({ title: ok ? L.cmCopied : L.pairCopyFailed, tone: ok ? 'done' : 'failed' });
  };
}

function useRevoke(): (row: PairedAppRow) => void {
  const L = useVocab();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: revokePairedDevice,
    onError: () => toast({ title: L.pairRevokeFailed, tone: 'failed' }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
  });
  return (row) => void confirmDialog({
    title: fmt(L.pairRevokeTitle, { name: row.name }), description: L.pairRevokeDesc,
    confirmLabel: L.pairRevoke, tone: 'danger',
  }).then((ok) => { if (ok) mutation.mutate(row.id); });
}

/** Settings → Machines: paired apps and the "connect a device" code, for desktop and mobile. */
export function usePairedApps(): PairedAppsController {
  const L = useVocab();
  const lang = useLang();
  const { toast } = useToast();
  const [minted, setMinted] = useState<MintedPairingCode | null>(null);
  const now = useNowTick(true, minted ? 1000 : 30_000);
  const live = minted && minted.expiresAt > now ? minted : null;
  // While a code is out, poll faster so the new app shows up soon after it pairs.
  const list = useQuery({ queryKey: QUERY_KEY, queryFn: fetchPairedDevices, retry: false, refetchInterval: live ? 5_000 : 60_000 });
  const create = useMutation({
    mutationFn: createPairingCode,
    onSuccess: setMinted,
    onError: () => toast({ title: L.pairCreateFailed, tone: 'failed' }),
  });
  const copy = useCopy();
  const address = pairingAddress(apiBase() || globalThis.location?.origin || '');
  const code = live ? activeCodeView(live, now, address, L) : null;
  return {
    visible: !!list.data,
    pairing: list.data?.pairing === true,
    rows: list.data ? pairedAppRows(list.data.devices, now, lang, L) : [],
    code,
    creating: create.isPending,
    createCode: () => create.mutate(),
    copyCode: () => void copy(code?.code),
    copyLink: () => void copy(code?.link),
    revoke: useRevoke(),
  };
}
