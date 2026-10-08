import { useEffect, useMemo } from 'react';
import { useTRPCClient } from '@/lib/trpc';
import { UsageSharingController } from '@/features/settings/vm/usage-sharing-vm';

/** One controller per mounted card, loaded once; the card subscribes to it for rendering. */
export function useUsageSharingController(): UsageSharingController {
  const client = useTRPCClient();
  const controller = useMemo(() => new UsageSharingController({
    get: () => client.usageSharing.get.query({}),
    set: input => client.usageSharing.set.mutate(input),
  }), [client]);
  useEffect(() => { void controller.load(); }, [controller]);
  return controller;
}
