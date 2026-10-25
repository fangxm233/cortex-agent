import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/design';
import { useVocab } from '@/i18n';
import { useTRPC } from '@/lib/trpc';
import { commitSettingValue, type SettingsSetArgs } from './runtime-settings-writer';

/** The Privacy section: what `telemetry.info` reports, and the one switch it offers. */
export function usePrivacyController() {
  const L = useVocab();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const info = useQuery(trpc.telemetry.info.queryOptions({}));
  const mutation = useMutation(trpc.config.set.mutationOptions());
  const [pending, setPending] = useState(false);
  const setEnabled = (enabled: boolean) => {
    if (pending) return;
    void commitSettingValue({
      set: (args: SettingsSetArgs) => mutation.mutateAsync(args as unknown as Parameters<typeof mutation.mutateAsync>[0]),
      // The bridge re-reads `telemetry.info` too, so the page stops or starts sending at once.
      refresh: () => Promise.all([
        queryClient.invalidateQueries(trpc.telemetry.info.queryFilter({})),
        queryClient.invalidateQueries(trpc.config.get.queryFilter({})),
      ]),
      onError: (message) => toast({ title: `${L.stToastWriteFailed}: ${message}`, tone: 'failed' }),
      onPending: setPending,
    }, 'telemetryEnabled', enabled);
  };
  return { info, pending, setEnabled };
}

export type PrivacyController = ReturnType<typeof usePrivacyController>;

/** Copy `text`, showing "copied" on the button for a moment. */
export function useCopyFeedback(text: string) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    }).catch(() => undefined);
  };
  return { copied, copy };
}
